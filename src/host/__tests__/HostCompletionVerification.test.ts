import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { readHostCompletionGatePolicy, readHostVerificationEligibility, readHostVerificationPolicy, readHostVerificationSettings, runHostVerificationCheck, type HostVerificationPolicyReader } from '../HostCompletionVerification';
import { CommandPolicy } from '../../backend/CommandPolicy';
import { CMD_SHELL } from '../../backend/__tests__/shellFixtures';
import type { CompletionVerificationCheckOptions } from '../../backend/CompletionVerificationCheck';
import { AgentCommandPolicy } from '../../backend/AgentCommandPolicy';
import { sameVerificationBinding } from '../../backend/CompletionVerificationPolicy';
import { policyVerifyResult } from '../../backend/CompletionPolicyVerifier';

function fixture() {
  const root = path.join(tmpdir(), 'unode-workflow-policy');
  let document: { completionVerification?: unknown } | undefined = { completionVerification: { mode: 'command', command: 'npm test' } };
  let skills: string[] = [];
  const inspect = vi.fn(() => ({ globalValue: 'npm run lint', workspaceValue: 'repository-command' }));
  const configuration = { inspect, get: vi.fn(() => { throw new Error('merged setting read'); }) };
  const reader: HostVerificationPolicyReader = {
    workspaceRoot: () => root, agentSkills: () => skills, readTeam: vi.fn(async () => document),
    configuration: () => configuration,
  };
  const execute = vi.fn(async () => ({ status: 'exited' as const, code: 0, output: 'checked' }));
  const options: Omit<CompletionVerificationCheckOptions, 'resolution' | 'currentResolution' | 'refreshResolution'> = {
    cwd: root, roots: [root], request: { kind: 'workflow', runId: 'run-A' }, signal: new AbortController().signal,
    isCurrentRequest: () => true, isTrusted: () => true, directoryAllowed: cwd => cwd === root,
    commandPolicy: () => new CommandPolicy('all'),
    prepare: () => ({ ok: true, shell: CMD_SHELL, execute, startBackground: () => { throw new Error('unused'); } }),
    readers: { manifest: async () => ({ kind: 'read', scripts: { test: 'test', lint: 'lint' } }), packageManager: async () => 'npm' },
  };
  return { root, reader, options, execute, configuration,
    document: (next: typeof document) => { document = next; }, skills: (next: string[]) => { skills = next; } };
}

describe('live host verification policy reader', () => {
  it('projects current team settings from User-only legacy input without execution', async () => {
    const h = fixture(); h.document(undefined);
    expect(await readHostVerificationSettings(h.reader)).toMatchObject({ kind: 'ready', source: 'legacy-global', command: 'npm run lint' });
    expect(h.configuration.get).not.toHaveBeenCalled();
    h.skills(['market-research']);
    expect(await readHostVerificationSettings(h.reader)).toMatchObject({ kind: 'ready', mode: 'disabled' });
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('keeps unreadable and workspace-stale display reads unavailable, without leaking raw text', async () => {
    const h = fixture();
    h.reader.readTeam = async () => { throw new Error('private-command'); };
    expect(await readHostVerificationSettings(h.reader)).toMatchObject({ kind: 'unavailable' });
    expect(JSON.stringify(await readHostVerificationSettings(h.reader))).not.toContain('private-command');
    let root = h.root;
    h.reader.workspaceRoot = () => root;
    h.reader.readTeam = async () => { root = `${h.root}-other`; return {}; };
    expect(await readHostVerificationSettings(h.reader)).toMatchObject({ kind: 'unavailable', detail: expect.stringContaining('workspace changed') });
  });
  it.each([{ skills: [] }, { skills: ['market-research'] }])('does not opt in an unconfigured team ($skills)', async ({ skills }) => {
    const h = fixture(); h.document(undefined); h.skills(skills);
    h.configuration.inspect.mockReturnValue({ globalValue: undefined as any, workspaceValue: 'repository-command' });
    expect(await readHostCompletionGatePolicy(h.reader)).toBeUndefined();
    expect(h.configuration.get).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   '])('empty User command %j does not enable the PM gate', async command => {
    const h = fixture(); h.document(undefined);
    h.configuration.inspect.mockReturnValue({ globalValue: command as any, workspaceValue: 'repository-command' });
    expect(await readHostCompletionGatePolicy(h.reader)).toBeUndefined();
  });

  it('an explicit auto policy opts in without reading the legacy command', async () => {
    const h = fixture(); h.document({ completionVerification: { mode: 'auto' } });
    expect(await readHostCompletionGatePolicy(h.reader)).toMatchObject({ kind: 'resolved', effective: { policy: { mode: 'auto' }, source: 'team-document' } });
    expect(h.configuration.inspect).not.toHaveBeenCalled();
  });

  it('a non-empty User command opts in; invalid commands stay visible rather than becoming defaults', async () => {
    const h = fixture(); h.document(undefined);
    expect(await readHostCompletionGatePolicy(h.reader)).toMatchObject({ kind: 'resolved', effective: { source: 'legacy-global' } });
    h.configuration.inspect.mockReturnValue({ globalValue: '\n', workspaceValue: 'repository-command' });
    expect(await readHostCompletionGatePolicy(h.reader)).toMatchObject({ kind: 'configuration-invalid', source: 'legacy-global' });
  });

  it('removing the explicit opt-in after gate selection cannot execute the default auto script', async () => {
    const h = fixture(); h.document({ completionVerification: { mode: 'auto' } });
    const captured = await readHostCompletionGatePolicy(h.reader);
    expect(captured).toBeDefined();
    h.document(undefined); h.configuration.inspect.mockReturnValue({ globalValue: undefined as any, workspaceValue: 'repository-command' });
    expect(await runHostVerificationCheck(h.reader, h.options, captured)).toMatchObject({ kind: 'not-run', reason: 'policy-stale' });
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('reads User/global only and never imports the workspace candidate', async () => {
    const h = fixture(); h.document(undefined);
    expect(await readHostVerificationPolicy(h.reader)).toMatchObject({ kind: 'resolved', effective: {
      policy: { mode: 'command', command: 'npm run lint' }, source: 'legacy-global',
    } });
    expect(h.configuration.inspect).toHaveBeenCalledWith('verifyCommand');
    expect(h.configuration.get).not.toHaveBeenCalled();
  });

  it('resolves the active knowledge team without consulting a previous software command', async () => {
    const h = fixture(); h.document(undefined); h.skills(['market-research']);
    expect(await runHostVerificationCheck(h.reader, h.options)).toMatchObject({ kind: 'not-run', reason: 'disabled' });
    expect(h.configuration.inspect).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('unreadable team data never becomes an absent-policy legacy fallback', async () => {
    const h = fixture(); h.reader.readTeam = async () => { throw new Error('private read error'); };
    const result = await runHostVerificationCheck(h.reader, h.options);
    expect(result).toMatchObject({ kind: 'not-run', reason: 'configuration-invalid', source: 'team-document' });
    expect(JSON.stringify(result)).not.toContain('private read error');
    expect(h.configuration.inspect).not.toHaveBeenCalled(); expect(h.execute).not.toHaveBeenCalled();
  });

  it('a current document is re-read after approval; changed policy cannot reuse that approval', async () => {
    const h = fixture(); h.options.commandPolicy = () => new CommandPolicy('ask');
    h.options.requestApproval = async () => { h.document({ completionVerification: { mode: 'command', command: 'npm run lint' } }); return { allow: true }; };
    expect(await runHostVerificationCheck(h.reader, h.options)).toMatchObject({ kind: 'not-run', reason: 'policy-stale' });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('the last strict read dominates a pass from both permission gates', async () => {
    const h = fixture();
    let reads = 0;
    h.reader.readTeam = async () => (++reads === 3
      ? { completionVerification: { mode: 'disabled' } }
      : { completionVerification: { mode: 'command', command: 'npm test' } });
    expect(await runHostVerificationCheck(h.reader, h.options)).toMatchObject({ kind: 'not-run', reason: 'policy-stale' });
    expect(reads).toBe(3); expect(h.execute).not.toHaveBeenCalled();
  });

  it('irrelevant document changes do not invalidate the policy binding', async () => {
    const h = fixture(); let reads = 0;
    h.reader.readTeam = async () => ({ completionVerification: { mode: 'command', command: 'npm test' }, members: [++reads] });
    expect(await runHostVerificationCheck(h.reader, h.options)).toMatchObject({ kind: 'passed' });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
});

describe('actual extension PM completion-gate factory', () => {
  const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const node = source.statements.find((entry): entry is ts.FunctionDeclaration => ts.isFunctionDeclaration(entry)
    && entry.name?.text === 'createAgentCompletionGate')!;
  const body = ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

  it.each(['software-default', 'knowledge-default', 'auto', 'legacy', 'new-turn'] as const)(
    '%s builds only an opted-in gate and keeps the pre-read owner identity', async mode => {
      const h = fixture(); h.document(mode === 'auto' || mode === 'new-turn' ? { completionVerification: { mode: 'auto' } } : undefined);
      if (mode === 'knowledge-default') h.skills(['market-research']);
      if (mode !== 'legacy') h.configuration.inspect.mockReturnValue({ globalValue: undefined as any, workspaceValue: 'repository-command' });
      let turnId = 'turn-A';
      const runTyped = vi.fn(async () => ({ kind: 'not-run' }));
      const host = {
        readHostCompletionGatePolicy, firstWorkspaceRoot: () => h.root,
        sessionManager: { currentRequestId: () => 'request-A', currentTurnId: () => turnId, getAll: () => [{ config: {} }] },
        skillsForAgent: () => h.reader.agentSkills(), persistence: { loadTeamConfig: async (options: unknown) => {
          expect(options).toEqual({ strict: true });
          if (mode === 'new-turn') turnId = 'turn-B';
          return h.reader.readTeam();
        } },
        vscode: { workspace: { getConfiguration: () => h.configuration } },
        runAgentVerification: runTyped,
      };
      const create = new Function('host', `with (host) { ${body}; return createAgentCompletionGate; }`)(host);
      const config = { id: 'pm' }; const cfg = { maxSelfRetries: 1, maxRedelegations: 0 };
      const gate = await create(config, 'launch-A', cfg);
      if (mode.endsWith('default')) expect(gate).toBeUndefined();
      else {
        expect(gate).toBeDefined();
        await expect(gate.run()).resolves.toMatchObject({ ok: false, blocked: true });
        expect(runTyped).not.toHaveBeenCalled();
        await gate.runTyped();
        expect(runTyped).toHaveBeenCalledWith(config, false, 'launch-A', expect.any(Object), { requestId: 'request-A', turnId: 'turn-A' });
      }
      expect(runTyped).toHaveBeenCalledTimes(mode.endsWith('default') ? 0 : 1);
    },
  );
});

describe('actual extension workflow verification entrance', () => {
  // Compile the actual host function rather than reproducing its configuration and permission wiring.
  const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const node = source.statements.find((entry): entry is ts.FunctionDeclaration => ts.isFunctionDeclaration(entry)
    && entry.name?.text === 'runWorkflowVerification')!;
  const body = ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

  it.each(['none', 'ask', 'all', 'untrusted', 'stopped', 'disabled', 'invalid', 'knowledge', 'switching'] as const)(
    '%s follows live policy, trust and run identity without an approval prompt', async mode => {
      const h = fixture();
      if (mode === 'disabled') h.document({ completionVerification: { mode: 'disabled' } });
      if (mode === 'invalid') h.document({ completionVerification: { mode: 'Auto' } });
      if (mode === 'knowledge') { h.document(undefined); h.skills(['market-research']); }
      // Use an unchecked command so the real production entrance needs no disk manifest in this test.
      if (!['disabled', 'invalid', 'knowledge'].includes(mode)) h.document({ completionVerification: { mode: 'command', command: 'node check.js' } });
      const loadTeamConfig = vi.fn(async (options: unknown) => { expect(options).toEqual({ strict: true }); return h.reader.readTeam(); });
      const host = {
        runHostVerificationCheck, firstWorkspaceRoot: () => h.root,
        agentRosterEdits: { admissionAllowed: mode !== 'switching' },
        sessionManager: { getAll: () => [{ config: {} }] }, skillsForAgent: () => h.reader.agentSkills(),
        persistence: { loadTeamConfig }, vscode: { workspace: { isTrusted: mode !== 'untrusted', getConfiguration: () => h.configuration } },
        commandPolicy: new CommandPolicy(mode === 'none' || mode === 'ask' ? mode : 'all'),
        verificationPreparer: h.options.prepare, verifyTimeoutMs: () => 1000, notifyVerifyCommandOutsideRoot: vi.fn(),
      };
      const run = new Function('host', `with (host) { ${body}; return runWorkflowVerification; }`)(host);
      const result = await run({ runId: 'workflow-A', workspaceRoot: h.root, signal: h.options.signal, isCurrent: () => mode !== 'stopped' });
      expect(loadTeamConfig).toHaveBeenCalled();
      expect(result.check.kind).toBe(mode === 'all' ? 'passed' : 'not-run');
      expect(result.ok).toBe(mode === 'all');
      expect(h.execute).toHaveBeenCalledTimes(mode === 'all' ? 1 : 0);
      expect(h.configuration.get).not.toHaveBeenCalled();
    },
  );
});

describe('actual extension policy-only session snapshot', () => {
  const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const node = source.statements.find((entry): entry is ts.FunctionDeclaration => ts.isFunctionDeclaration(entry)
    && entry.name?.text === 'readAgentVerificationSnapshot')!;
  const body = ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  it.each(['software', 'knowledge', 'disabled', 'invalid', 'unreadable', 'restricted', 'untrusted', 'task-scope'] as const)(
    '%s records the same policy/source without preparing or executing a command', async mode => {
      const h = fixture(); h.document(undefined);
      if (mode === 'knowledge') h.skills(['market-research']);
      if (mode === 'disabled') h.document({ completionVerification: { mode: 'disabled' } });
      if (mode === 'invalid') h.document({ completionVerification: { mode: 'Auto' } });
      if (mode === 'unreadable') h.reader.readTeam = async () => { throw new Error('private error'); };
      const host = { readHostVerificationEligibility: (reader: HostVerificationPolicyReader, cwd: string) =>
        readHostVerificationEligibility(reader, cwd, h.options.readers),
      firstWorkspaceRoot: () => h.root, skillsForAgent: () => h.reader.agentSkills(),
      sessionManager: { currentTurnHasTaskScope: () => mode === 'task-scope', getAll: () => [{ config: {} }] },
      persistence: { loadTeamConfig: async (options: unknown) => { expect(options).toEqual({ strict: true }); return h.reader.readTeam(); } },
      vscode: { workspace: { isTrusted: mode !== 'untrusted', getConfiguration: () => h.configuration } } };
      const run = new Function('host', `with (host) { ${body}; return readAgentVerificationSnapshot; }`)(host);
      const snapshot = await run({ id: 'dev', ...(mode === 'restricted' ? { folderAccess: ['docs'] } : {}) }, h.root);
      expect(snapshot.kind).toBe(mode === 'software' ? 'ready' : mode === 'knowledge' || mode === 'disabled' ? 'disabled'
        : mode === 'invalid' || mode === 'unreadable' ? 'configuration-invalid' : 'restricted');
      if (mode === 'software') expect(snapshot).toMatchObject({ source: 'legacy-global', command: 'npm run lint' });
      if (mode === 'knowledge') expect(h.configuration.inspect).not.toHaveBeenCalled();
      expect(h.configuration.get).not.toHaveBeenCalled(); expect(h.execute).not.toHaveBeenCalled();
      expect(JSON.stringify(snapshot)).not.toContain('private error');
    },
  );

  it('does not retain a ready eligibility snapshot when the policy changes during manifest I/O', async () => {
    const h = fixture();
    h.options.readers!.manifest = async () => { h.document({ completionVerification: { mode: 'disabled' } }); return { kind: 'read', scripts: { test: 'test' } }; };
    expect(await readHostVerificationEligibility(h.reader, h.root, h.options.readers)).toEqual({ kind: 'unavailable' });
    expect(h.execute).not.toHaveBeenCalled();
  });
});

describe('actual extension worktree verification entrance', () => {
  const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const node = source.statements.find((entry): entry is ts.FunctionDeclaration => ts.isFunctionDeclaration(entry)
    && entry.name?.text === 'runWorktreeVerification')!;
  const body = ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

  it('the actual coordinator factory registers the typed entrance and observes the real lane revision', async () => {
    const declaration = source.statements.find((entry): entry is ts.FunctionDeclaration => ts.isFunctionDeclaration(entry)
      && entry.name?.text === 'makeWorktreeCoordinator')!;
    const js = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const root = path.join(tmpdir(), 'factory-workspace'); const runWorktreeVerification = vi.fn(async () => ({}));
    const runGitIn = vi.fn(async () => ({ code: 0, stdout: 'a'.repeat(40) }));
    let workspace = root;
    const host: any = { firstWorkspaceRoot: () => workspace, WorktreeCoordinator: class { constructor(readonly deps: any) {} },
      WorktreeManager: class {}, GitMergeOrchestrator: class {}, runWorktreeVerification, runGitIn,
      changedFilesInWorktree: vi.fn(), configuredSetting: vi.fn(() => 'worktree'), canDelegate: vi.fn(), outputChannel: { info: vi.fn() },
      vscode: { workspace: { isTrusted: true } }, sessionManager: { withIdleLaneWork: async (_id: string, operation: any) => operation(() => true) },
      messageBus: { send: vi.fn() }, warnWorktreeNeedsGit: vi.fn(), notifyUnverifiedWorktreeMerge: vi.fn() };
    const make = new Function('host', `with (host) { ${js}; return makeWorktreeCoordinator; }`)(host);
    const coordinator = make(); const { deps } = coordinator; host.worktreeCoordinator = coordinator;
    const wt = { path: path.join(root, 'lane'), agentId: 'dev' }; const owner = {};
    expect(deps.verify).toBeUndefined(); await deps.verifyTyped(wt, owner);
    expect(runWorktreeVerification).toHaveBeenCalledWith(root, wt, owner);
    expect(await deps.revision(wt)).toBe('a'.repeat(40));
    expect(runGitIn).toHaveBeenCalledWith(wt.path, ['rev-parse', 'HEAD']);
    await deps.withManualMergeAdmission(wt, async (current: () => boolean) => {
      expect(current()).toBe(true);
      host.vscode.workspace.isTrusted = false; expect(current()).toBe(false); host.vscode.workspace.isTrusted = true;
      workspace = 'different workspace'; expect(current()).toBe(false); workspace = root;
      host.worktreeCoordinator = {}; expect(current()).toBe(false); host.worktreeCoordinator = coordinator;
      host.configuredSetting.mockReturnValue('optimistic'); expect(current()).toBe(false);
    });
    runGitIn.mockResolvedValue({ code: 0, stdout: '' }); expect(await deps.laneIsClean(wt)).toBe(true);
    runGitIn.mockResolvedValue({ code: 0, stdout: ' M file' }); expect(await deps.laneIsClean(wt)).toBe(false);
  });

  it.each(['all', 'outside-lane', 'ask', 'none', 'narrowed', 'no-execute', 'task-scope', 'folder-scope', 'disabled', 'invalid', 'unreadable', 'untrusted', 'gate-off', 'old-owner', 'wrong-cwd', 'switching'] as const)(
    '%s respects the original worker, its actual cwd and live narrowing with no prompt', async mode => {
      const h = fixture(); h.document({ completionVerification: { mode: mode === 'disabled' ? 'disabled' : 'command',
        ...(mode === 'disabled' ? {} : { command: 'node check.js' }) } });
      if (mode === 'invalid') h.document({ completionVerification: { mode: 'Auto' } });
      if (mode === 'unreadable') h.reader.readTeam = async () => { throw new Error('private error'); };
      if (mode === 'outside-lane') h.document({ completionVerification: { mode: 'command', command: `node "${path.join(h.root, 'check.js')}"` } });
      const lane = path.join(h.root, 'lane');
      const config = { id: 'dev', name: 'Dev', ...(mode === 'folder-scope' ? { folderAccess: ['docs'] } : {}),
        ...(mode === 'narrowed' ? { commandNarrowing: { approvalMode: 'none', allowedCommands: [] } } : {}) };
      const host = { readHostVerificationPolicy, runHostVerificationCheck, sameVerificationBinding, policyVerifyResult,
        agentRosterEdits: { admissionAllowed: mode !== 'switching' },
        delegationCapabilitiesFor: () => ({ shell: mode !== 'no-execute' }),
        AgentCommandPolicy, firstWorkspaceRoot: () => h.root,
        sessionManager: { getAll: () => [{ config }], get: () => ({ config, runtimeWorkingDirectory: mode === 'wrong-cwd' ? h.root : lane }) },
        skillsForAgent: () => [], persistence: { loadTeamConfig: async (options: unknown) => { expect(options).toEqual({ strict: true }); return h.reader.readTeam(); } },
        vscode: { workspace: { isTrusted: mode !== 'untrusted', getConfiguration: () => h.configuration } },
        configuredSetting: (key: string) => key === 'concurrencyStrategy' ? 'worktree' : mode !== 'gate-off',
        commandPolicy: new CommandPolicy(mode === 'ask' || mode === 'none' ? mode : 'all'),
        verificationPreparer: h.options.prepare, verifyTimeoutMs: () => 1000, notifyVerifyCommandOutsideRoot: vi.fn(),
      };
      const run = new Function('host', `with (host) { ${body}; return runWorktreeVerification; }`)(host);
      const owner = { request: { kind: 'session', sessionId: 'dev', requestId: 'request-A', attemptId: 'turn-A' },
        hasTaskScope: mode === 'task-scope', signal: h.options.signal, isCurrent: () => mode !== 'old-owner' };
      const result = await run(h.root, { path: lane, branch: 'unode/dev', agentId: 'dev' }, owner);
      const allowed = mode === 'all' || mode === 'outside-lane';
      expect(result.check.kind).toBe(allowed ? 'passed' : 'not-run');
      expect(h.execute).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(result.mergeAdmission.isCurrent()).toBe(allowed);
      if (mode === 'outside-lane') expect(host.notifyVerifyCommandOutsideRoot).toHaveBeenCalled();
      if (mode === 'all') {
        expect(h.execute).toHaveBeenCalledWith('node check.js', expect.objectContaining({ cwd: lane }));
        host.commandPolicy = new CommandPolicy('none'); expect(result.mergeAdmission.isCurrent()).toBe(false);
        host.commandPolicy = new CommandPolicy('all');
        host.vscode.workspace.isTrusted = false; expect(result.mergeAdmission.isCurrent()).toBe(false);
        host.vscode.workspace.isTrusted = true;
        h.document({ completionVerification: { mode: 'disabled' } });
        await result.mergeAdmission.refresh(); expect(result.mergeAdmission.isCurrent()).toBe(false);
      }
      expect(h.configuration.get).not.toHaveBeenCalled();
      if (mode === 'invalid' || mode === 'unreadable') {
        expect(result.check.reason).toBe('configuration-invalid');
        expect(JSON.stringify(result.check)).not.toContain('private error');
      }
    },
  );
});

describe('actual extension agent verification entrance', () => {
  const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const node = source.statements.find((entry): entry is ts.FunctionDeclaration => ts.isFunctionDeclaration(entry)
    && entry.name?.text === 'runAgentVerification')!;
  const body = ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

  it.each(['all', 'agent-none', 'folder-confined', 'task-confined', 'untrusted', 'old-launch', 'captured-owner', 'ask-unattended', 'approved', 'request-replaced', 'turn-replaced', 'stopped-during-approval', 'switching'] as const)(
    '%s uses the calling agent scope and original request instead of a global fallback', async mode => {
      const h = fixture();
      h.document({ completionVerification: { mode: 'command', command: 'node check.js' } });
      let requestId = 'request-A'; let turnId = 'turn-A';
      const config = { id: 'pm', name: 'PM', workingDirectory: h.root,
        ...(mode === 'agent-none' ? { commandNarrowing: { approvalMode: 'none', allowedCommands: [] } } : {}),
        ...(mode === 'folder-confined' ? { folderAccess: [{ path: 'docs', permission: 'read' }] } : {}),
      };
      const listeners = new Map<string, Set<(event: { sessionId: string }) => void>>();
      const approval = vi.fn(async () => {
        if (mode === 'request-replaced') requestId = 'request-B';
        if (mode === 'turn-replaced') turnId = 'turn-B';
        if (mode === 'stopped-during-approval') listeners.get('session.turnEnded')?.forEach(listener => listener({ sessionId: config.id }));
        return { allow: true };
      });
      const host = {
        runHostVerificationCheck, AgentCommandPolicy, firstWorkspaceRoot: () => h.root, AbortController,
        agentRosterEdits: { admissionAllowed: mode !== 'switching' },
        sessionManager: {
          recordVerificationCheck: vi.fn(),
          isCurrentBackendLaunch: (_id: string, launchId: string) => launchId === 'launch-A' && mode !== 'old-launch',
          currentTurnHasTaskScope: () => mode === 'task-confined',
          currentRequestId: () => requestId, currentTurnId: () => turnId,
          get: () => ({ config, status: 'running' }), getAll: () => [{ config }],
          on: (name: string, listener: (event: { sessionId: string }) => void) => {
            const group = listeners.get(name) ?? new Set(); group.add(listener); listeners.set(name, group);
          },
          off: (name: string, listener: (event: { sessionId: string }) => void) => { listeners.get(name)?.delete(listener); },
        },
        skillsForAgent: () => [], persistence: { loadTeamConfig: async (options: unknown) => {
          expect(options).toEqual({ strict: true }); return h.reader.readTeam();
        } },
        vscode: { workspace: { isTrusted: mode !== 'untrusted', getConfiguration: () => h.configuration } },
        commandPolicy: new CommandPolicy(['ask-unattended', 'approved', 'request-replaced', 'turn-replaced', 'stopped-during-approval'].includes(mode) ? 'ask' : 'all'),
        verificationPreparer: h.options.prepare, verifyTimeoutMs: () => 1000,
        notifyVerifyCommandOutsideRoot: vi.fn(), requestCommandApproval: approval,
      };
      const run = new Function('host', `with (host) { ${body}; return runAgentVerification; }`)(host);
      const owner = mode === 'captured-owner' ? { requestId: 'request-before', turnId: 'turn-before' } : undefined;
      const check = await run(config, mode !== 'ask-unattended', 'launch-A', undefined, owner);
      const allowed = mode === 'all' || mode === 'approved';
      expect(check.kind).toBe(allowed ? 'passed' : 'not-run');
      expect(h.execute).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(host.sessionManager.recordVerificationCheck).toHaveBeenCalledWith(config.id, owner?.requestId ?? 'request-A', owner?.turnId ?? 'turn-A', check,
        mode === 'ask-unattended' ? 'completion-gate' : 'run-checks', 'launch-A');
      if (mode === 'approved') expect(approval).toHaveBeenCalledTimes(1);
      if (mode === 'ask-unattended') expect(approval).not.toHaveBeenCalled();
      expect([...listeners.values()].every(group => group.size === 0)).toBe(true);
    },
  );
});
