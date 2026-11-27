import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../types';
import { SessionManager } from '../../session/SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import { OpenAICompatBackend, type FetchFn } from '../../backend/OpenAICompatBackend';
import { fullFileAccessGuidance, localReadScopeGuidance, outsidePathGrantGuidance } from '../../backend/localReadScope';
import { AUTONOMY_DEFAULT_CONSENT_KEY, AUTONOMY_MENU_LABEL, AUTONOMY_MENU_MODES, AutonomyDefaultConsent,
  autonomyModeForCodexProfile, isAutonomyMode, plainAutonomyLimit, resolveAutonomyPolicy,
  type AutonomyChoice, type AutonomyMode } from '../../settings/AutonomyPolicy';

const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['setAgentAutonomy', 'setDefaultAutonomy', 'writeAutonomyUserMode', 'reconcileAutonomyDefault',
  'notePendingNativeAutonomy', 'agentAutonomyPolicy', 'autonomyForAgent', 'refreshAutonomyOnConfigurationChange', 'reconcileAutonomyDefaultInBackground',
  'autonomyMenuForAgent', 'fileReachGuidance'];
const statements = names.map(name => {
  const node = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!node) throw new Error(`Missing actual ${name}`);
  return node.getText(source);
});
const disclosure = source.statements.find(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(declaration => declaration.name.getText(source) === 'FULL_ACCESS_DISCLOSURE'));
if (!disclosure) throw new Error('Missing actual Full access disclosure');
const actual = ts.transpileModule([disclosure.getText(source), ...statements].join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function agent(id: string, patch: Partial<AgentConfig> = {}): AgentConfig {
  return { id, name: `Agent ${id}`, role: 'developer', skill: 'code-generation',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, model: 'fixture-model',
    systemPrompt: '', autoApprove: true, backend: 'openai-compat', allowedTools: ['read', 'write', 'execute'], ...patch };
}
function deferred<T = unknown>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(configs = [agent('a'), agent('b')], configured: AutonomyMode = 'workspace', savedConsent = false) {
  const values = new Map<string, unknown>([['roam.messages', ['newest']], ['roam.runs', []],
    [AUTONOMY_DEFAULT_CONSENT_KEY, savedConsent]]);
  const state = { get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => { values.set(key, value); } };
  const defaults = new AutonomyDefaultConsent(state);
  const user: Record<string, unknown> = { autonomy: configured, commandApproval: 'all', writeApproval: 'none' };
  const sessions = configs.map(config => ({ config, status: 'idle' }));
  const turns = new Map<string, { id: string; mode: 'plan' | 'act'; taskScoped?: boolean }>();
  const sessionManager = {
    get: (id: string) => sessions.find(session => session.config.id === id), getAll: () => sessions,
    currentTurnId: (id: string) => turns.get(id)?.id, currentTurnMode: (id: string) => turns.get(id)?.mode,
    currentTurnHasTaskScope: (id: string) => turns.get(id)?.taskScoped ?? false,
    start: vi.fn(), restart: vi.fn(), send: vi.fn(), create: vi.fn(),
  };
  const host = {
    // v0.9.101 (the access table): a change of an agent's reach re-judges its rows.
    accessInputsChanged: () => undefined,
    autonomyDefaults: defaults, agentAutonomyGenerations: new Map<string, number>(), agentAutonomyDecisionGenerations: new Map<string, number>(),
    codexAutonomyPendingTurns: new Map<string, string>(), expectedAutonomySetting: undefined as unknown,
    codexNativePolicySnapshots: new Map<string, { turnId: string; profile: string; current(): string }>(),
    lastAutonomyUserSetting: configured as string,
    lastAutonomyAdvancedFingerprint: JSON.stringify([user.commandApproval, [], user.writeApproval]), autonomyPolicyGeneration: 0,
    vscode: { workspace: { isTrusted: true }, window: { showWarningMessage: vi.fn(async (..._args: unknown[]): Promise<unknown> => 'Enable full access') } },
    sessionManager, effectiveConnectionRegistry: {}, defaultBackendKind: (config: AgentConfig) => config.backend ?? 'openai-compat',
    fullFileAccessGuidance, localReadScopeGuidance, outsidePathGrantGuidance, firstWorkspaceRoot: () => '/work/projects/app',
    resolveAutonomyPolicy, isAutonomyMode, AUTONOMY_MENU_LABEL, AUTONOMY_MENU_MODES, autonomyModeForCodexProfile, plainAutonomyLimit,
    // The backend's own resolver; each test that needs a cap replaces it.
    codexPermissionForAgent: undefined as unknown as (config: AgentConfig, mode: 'plan' | 'act') => { configured: string; effective: string; capReason?: string },
    commandPolicy: { get approvalMode() { return user.commandApproval; } },
    configuredSetting: (key: string, fallback: unknown) => Object.hasOwn(user, key) ? user[key] : fallback,
    updateUserAuthoritySetting: vi.fn(async (key: string, value: unknown) => { user[key] = value; }),
    saveRoster: vi.fn(async () => {}), showResultNotice: vi.fn(),
    teamViewProvider: { refresh: vi.fn() }, chatViewProvider: { refresh: vi.fn(), getAgentMode: () => 'act' },
    SettingsPanel: { refreshCurrent: vi.fn() },
    scan: vi.fn(), download: vi.fn(), modelRequest: vi.fn(), launchProgram: vi.fn(),
  };
  const handlers = new Function('host', `with (host) { ${actual}; return { ${names.join(', ')} }; }`)(host) as {
    setAgentAutonomy(id: string, choice: AutonomyChoice): Promise<void>;
    setDefaultAutonomy(mode: AutonomyMode): Promise<void>;
    writeAutonomyUserMode(mode: AutonomyMode): Promise<void>;
    reconcileAutonomyDefault(): Promise<void>;
    refreshAutonomyOnConfigurationChange(event: { affectsConfiguration(key: string): boolean }): void;
    reconcileAutonomyDefaultInBackground(): void;
    notePendingNativeAutonomy(config: AgentConfig): void;
    autonomyForAgent(config: AgentConfig, mode?: 'act' | 'plan'): ReturnType<typeof resolveAutonomyPolicy>;
    agentAutonomyPolicy(config: AgentConfig, mode?: 'act' | 'plan'): ReturnType<typeof resolveAutonomyPolicy>;
    fileReachGuidance(config: AgentConfig): string;
    autonomyMenuForAgent(config: AgentConfig, backend: string): { selected: AutonomyMode; items: Array<{ mode: AutonomyMode; label: string; description: string }> };
  };
  // Uncapped by default: the backend runs the configured native profile.
  host.codexPermissionForAgent = (config, mode) => {
    const configured = handlers.autonomyForAgent(config, mode).codexProfile;
    return { configured, effective: configured };
  };
  return { ...handlers, host, values, defaults, user, sessions, turns };
}

describe('actual extension Autonomy choice wiring', () => {
  it('tells each turn the file reach Autonomy currently gives this agent', async () => {
    const h = fixture([agent('a'), agent('b')]);
    expect(h.fileReachGuidance(h.sessions[0].config)).toMatch(/unless the user grants access to an outside path/);
    // v0.9.100 (field, 4523a765): an agent that is not on Full access is told an outside path can be granted.
    expect(h.fileReachGuidance(h.sessions[0].config)).toContain('## Paths outside the workspace (host setting)');
    await h.setAgentAutonomy('a', 'full-access');
    expect(h.fileReachGuidance(h.sessions[0].config)).toContain('Full access is on for you now');
    expect(h.fileReachGuidance(h.sessions[0].config)).not.toMatch(/unless the user grants access/);
    expect(h.fileReachGuidance(h.sessions[0].config)).not.toContain('## Paths outside the workspace');
    // Only that agent, and a live change reaches its next turn.
    expect(h.fileReachGuidance(h.sessions[1].config)).toMatch(/unless the user grants access/);
    await h.setAgentAutonomy('a', 'workspace');
    expect(h.fileReachGuidance(h.sessions[0].config)).toMatch(/unless the user grants access/);

    const codex = fixture([agent('c', { backend: 'codex', autonomyMode: 'full-access' })]);
    expect(codex.fileReachGuidance(codex.sessions[0].config)).toContain('Your writes follow your Codex permission setting');
    // Folder Access and Workspace Trust keep Full access off, so the agent is not told it is on.
    const limited = fixture([agent('d', { autonomyMode: 'full-access', folderAccess: [{ path: '/reports', permission: 'read' }] })]);
    expect(limited.fileReachGuidance(limited.sessions[0].config)).not.toContain('Full access is on');
    const untrusted = fixture([agent('e', { autonomyMode: 'full-access' })]);
    untrusted.host.vscode.workspace.isTrusted = false;
    expect(untrusted.fileReachGuidance(untrusted.sessions[0].config)).toBe('');
  });

  it('only the exact Full access button enables the chosen agent', async () => {
    for (const answer of [undefined, 'Enable', true, 'Enable full access']) {
      const h = fixture();
      h.host.vscode.window.showWarningMessage.mockResolvedValue(answer);
      await h.setAgentAutonomy('a', 'full-access');
      expect(h.sessions[0].config.autonomyMode).toBe(answer === 'Enable full access' ? 'full-access' : undefined);
      expect(h.sessions[1].config.autonomyMode).toBeUndefined();
      const detail = (h.host.vscode.window.showWarningMessage.mock.calls[0][1] as { detail: string }).detail;
      expect(detail).toContain('This changes only Agent a');
      expect(detail).toContain('including personal and credential files');
      expect(detail).toContain('configured model provider');
      expect(detail).toContain('Native Codex Full access');
    }
  });

  it('changes only the exact actor and preserves Off, Ask and folder restrictions without starting work', async () => {
    const constrained = agent('a', { autoApprove: false, executePreference: 'deny', allowedTools: ['read', 'write'],
      folderAccess: [{ path: '/reports', permission: 'read' }], commandNarrowing: { approvalMode: 'none' } });
    const h = fixture([constrained, agent('b')]);
    h.user.commandApproval = 'none'; h.user.writeApproval = 'ask';
    const prior = structuredClone(constrained);
    await h.setAgentAutonomy('a', 'full-access');
    expect(h.sessions[0].config).toEqual({ ...prior, autonomyMode: 'full-access' });
    expect(h.sessions[1].config.autonomyMode).toBeUndefined();
    expect(h.user).toMatchObject({ autonomy: 'workspace', commandApproval: 'none', writeApproval: 'ask' });
    expect(h.autonomyForAgent(constrained)).toMatchObject({ fullFileAccess: false, writeReview: true });
    expect(h.autonomyForAgent(constrained).label).toContain('Custom');
    for (const spy of [h.host.sessionManager.start, h.host.sessionManager.restart, h.host.sessionManager.send,
      h.host.sessionManager.create, h.host.scan, h.host.download, h.host.modelRequest, h.host.launchProgram]) expect(spy).not.toHaveBeenCalled();
  });

  it('previews actual current inheritors, legacy ambiguity and future trusted-project inheritance', async () => {
    const h = fixture([agent('irrelevant', { name: 'Unrelated existing actor', autonomyMode: 'review' }),
      agent('a', { name: 'Inheriting writer' }), agent('legacy', { name: 'Legacy Codex', backend: 'codex', codexPermissionProfile: 'approve-for-me' }),
      agent('ask', { name: 'Native Ask', backend: 'codex', codexPermissionProfile: 'ask-for-approval' })]);
    await h.setDefaultAutonomy('full-access');
    const detail = (h.host.vscode.window.showWarningMessage.mock.calls[0][1] as { detail: string }).detail;
    expect(detail).toContain('Inheriting writer'); expect(detail).toContain('Legacy Codex'); expect(detail).toContain('Native Ask');
    expect(detail).not.toContain('Unrelated existing actor');
    expect(detail).toContain('unknown default-versus-explicit origin');
    expect(detail).toContain('Future agents from any trusted project team file inherit it unless independently restricted');
    expect(detail).toContain('Saved native Codex Ask and Full access choices remain separate');
    expect(h.autonomyForAgent(h.sessions[2].config).codexProfile).toBe('full-access');
    expect(h.autonomyForAgent(h.sessions[3].config).codexProfile).toBe('ask-for-approval');
    expect(h.sessions[0].config.autonomyMode).toBe('review');
  });

  it('reads and reapplies a saved unchanged Full access default without another question or launch', async () => {
    const h = fixture([agent('a')], 'full-access', true);
    expect(h.autonomyForAgent(h.sessions[0].config).fullFileAccess).toBe(true);
    await h.setDefaultAutonomy('full-access'); await h.reconcileAutonomyDefault();
    expect(h.host.vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.host.updateUserAuthoritySetting).not.toHaveBeenCalled();
    expect(h.host.sessionManager.start).not.toHaveBeenCalled();
    expect(h.defaults.revision).toBe(0);
    const perAgent = fixture([agent('a', { autonomyMode: 'full-access' })]);
    perAgent.host.agentAutonomyGenerations.set('a', 7);
    await perAgent.setAgentAutonomy('a', 'full-access');
    expect(perAgent.host.vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(perAgent.host.saveRoster).not.toHaveBeenCalled();
    expect(perAgent.host.agentAutonomyGenerations.get('a')).toBe(7);
    expect(perAgent.autonomyForAgent(perAgent.sessions[0].config).fullFileAccess).toBe(true);
  });

  it('late per-agent answers cannot survive trust loss, removal, actor replacement or a newer choice', async () => {
    for (const ending of ['trust', 'removed', 'replaced', 'newer', 'same-choice'] as const) {
      const h = fixture(); const original = h.sessions[0].config; const answer = deferred();
      h.host.vscode.window.showWarningMessage.mockReturnValue(answer.promise);
      const pending = h.setAgentAutonomy('a', 'full-access');
      if (ending === 'trust') h.host.vscode.workspace.isTrusted = false;
      else if (ending === 'removed') h.sessions.shift();
      else if (ending === 'replaced') h.sessions.splice(0, 1, { config: agent('a'), status: 'idle' });
      else await h.setAgentAutonomy('a', ending === 'same-choice' ? 'inherit' : 'review');
      answer.resolve('Enable full access'); await pending;
      expect(original.autonomyMode).not.toBe('full-access');
      expect(h.host.sessionManager.get('a')?.config.autonomyMode).not.toBe('full-access');
    }
  });

  it('an independent actor choice does not retire another actors pending approval', async () => {
    const h = fixture(); const answer = deferred();
    h.host.vscode.window.showWarningMessage.mockReturnValue(answer.promise);
    const pending = h.setAgentAutonomy('a', 'full-access');
    await h.setAgentAutonomy('b', 'review');
    answer.resolve('Enable full access'); await pending;
    expect(h.sessions[0].config.autonomyMode).toBe('full-access');
    expect(h.sessions[1].config.autonomyMode).toBe('review');
  });

  it('a declined manual User setting is reconciled to the prior effective mode without granting authority', async () => {
    const h = fixture([agent('a')], 'full-access');
    h.host.vscode.window.showWarningMessage.mockResolvedValue(undefined);
    expect(h.autonomyForAgent(h.sessions[0].config).fullFileAccess).toBe(false);
    await h.reconcileAutonomyDefault();
    expect(h.user.autonomy).toBe('workspace');
    expect(h.defaults.effective(h.user.autonomy)).toBe('workspace');
    expect(h.values.get(AUTONOMY_DEFAULT_CONSENT_KEY)).not.toBe(true);
    expect(h.host.expectedAutonomySetting).toBeUndefined();
    expect(h.host.sessionManager.start).not.toHaveBeenCalled();
  });

  it('an obsolete default answer cannot roll back a newer deliberate default', async () => {
    for (const newer of ['review', 'workspace'] as const) {
      const h = fixture([agent('a')], newer === 'review' ? 'full-access' : 'workspace'); const answer = deferred();
      h.host.vscode.window.showWarningMessage.mockReturnValue(answer.promise);
      const pending = h.setDefaultAutonomy('full-access');
      await h.setDefaultAutonomy(newer);
      answer.resolve('Enable full access'); await pending;
      expect(h.user.autonomy).toBe(newer);
      expect(h.defaults.effective(h.user.autonomy)).toBe(newer);
      if (newer === 'review') expect(h.host.updateUserAuthoritySetting.mock.calls.map(([, value]) => value)).not.toContain('workspace');
    }
    const h = fixture([agent('a')], 'full-access');
    const oldAnswer = deferred(); const newAnswer = deferred();
    h.host.vscode.window.showWarningMessage.mockReturnValueOnce(oldAnswer.promise).mockReturnValueOnce(newAnswer.promise);
    const older = h.setDefaultAutonomy('full-access');
    const newer = h.setDefaultAutonomy('full-access');
    newAnswer.resolve('Enable full access'); await newer;
    oldAnswer.resolve(undefined); await older;
    expect(h.user.autonomy).toBe('full-access');
    expect(h.defaults.effective(h.user.autonomy)).toBe('full-access');
  });

  it('shows a native Codex policy change as pending only for the already-running turn and uses actual turn ceilings', async () => {
    const h = fixture([agent('a', { backend: 'codex', codexPermissionProfile: 'approve-for-me' })]);
    h.turns.set('a', { id: 'old-turn', mode: 'act' });
    await h.setAgentAutonomy('a', 'full-access');
    const pending = h.autonomyForAgent(h.sessions[0].config);
    expect(pending.label).toBe('Custom · native Codex change pending');
    expect(pending.detail).toContain('running native Codex turn retains its started policy');
    expect(pending.detail).toContain('press Stop in chat');
    h.turns.set('a', { id: 'new-turn', mode: 'plan', taskScoped: true });
    const next = h.autonomyForAgent(h.sessions[0].config);
    expect(next.label).not.toContain('pending');
    expect(next.limits).toContain('Plan is read only');
    expect(next.limits).toContain('the current task narrows file access');
    expect(next.detail).toContain('changes are disabled');
    const independent = fixture([agent('explicit', { backend: 'codex', autonomyMode: 'full-access' })]);
    independent.turns.set('explicit', { id: 'unrelated-default-change', mode: 'act' });
    await independent.setDefaultAutonomy('review');
    expect(independent.autonomyForAgent(independent.sessions[0].config).label).toBe('Full access');
    expect(independent.host.codexAutonomyPendingTurns.has('explicit')).toBe(false);
  });

  it('keeps a valid live choice visible when roster persistence fails and reports the reload limitation', async () => {
    const h = fixture([agent('a')]);
    h.host.saveRoster.mockRejectedValue(new Error('fixture storage failure'));
    await expect(h.setAgentAutonomy('a', 'full-access')).resolves.toBeUndefined();
    expect(h.sessions[0].config.autonomyMode).toBe('full-access');
    expect(h.autonomyForAgent(h.sessions[0].config).fullFileAccess).toBe(true);
    expect(h.host.showResultNotice).toHaveBeenCalledWith('warning', expect.stringMatching(/reload/i));
    expect(h.host.teamViewProvider.refresh).toHaveBeenCalled();
    expect(h.host.chatViewProvider.refresh).toHaveBeenCalled();
    expect(h.host.SettingsPanel.refreshCurrent).toHaveBeenCalled();
  });

  it('a synchronous configuration callback for the accepted own write neither reasks nor cancels the enable', async () => {
    const h = fixture([agent('a')]);
    const event = { affectsConfiguration: (key: string) => key === 'unode.autonomy' };
    h.host.updateUserAuthoritySetting.mockImplementation(async (key, value) => {
      h.user[key] = value;
      h.refreshAutonomyOnConfigurationChange(event);
    });
    await h.setDefaultAutonomy('full-access');
    expect(h.host.vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(h.defaults.revision).toBe(1);
    expect(h.autonomyForAgent(h.sessions[0].config).fullFileAccess).toBe(true);
    expect(h.host.expectedAutonomySetting).toBeUndefined();
    expect(h.host.lastAutonomyUserSetting).toBe('full-access');
    const native = fixture([agent('a', { backend: 'codex', codexPermissionProfile: 'approve-for-me' })], 'full-access', true);
    native.turns.set('a', { id: 'started-in-full', mode: 'act' });
    const entered = deferred(); const release = deferred();
    native.host.updateUserAuthoritySetting.mockImplementation(async (key, value) => {
      native.user[key] = value;
      native.refreshAutonomyOnConfigurationChange(event);
      entered.resolve(undefined); await release.promise;
    });
    const pending = native.setDefaultAutonomy('review');
    await entered.promise;
    const labelDuringPersistence = native.autonomyForAgent(native.sessions[0].config).label;
    release.resolve(undefined); await pending;
    expect(labelDuringPersistence).toBe('Custom · native Codex change pending');
  });

  it('an own write with no event cannot hide later manual Workspace and Full access changes', async () => {
    const h = fixture([agent('a', { backend: 'codex', codexPermissionProfile: 'approve-for-me' })]);
    const event = { affectsConfiguration: (key: string) => key === 'unode.autonomy' };
    await h.setDefaultAutonomy('full-access'); // This configuration port emits no change event.
    expect(h.host.expectedAutonomySetting).toBeUndefined();
    h.turns.set('a', { id: 'native-full-turn', mode: 'act' });
    const revision = h.defaults.revision;
    h.user.autonomy = 'workspace';
    h.refreshAutonomyOnConfigurationChange(event);
    expect(h.defaults.revision).toBeGreaterThan(revision);
    expect(h.host.codexAutonomyPendingTurns.get('a')).toBe('native-full-turn');
    expect(h.autonomyForAgent(h.sessions[0].config).label).toContain('native Codex change pending');
    const answer = deferred();
    h.host.vscode.window.showWarningMessage.mockReturnValue(answer.promise);
    h.user.autonomy = 'full-access';
    h.refreshAutonomyOnConfigurationChange(event);
    expect(h.host.vscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
    expect(h.autonomyForAgent(h.sessions[0].config).fullFileAccess).toBe(false);
    answer.resolve('Enable full access');
    await vi.waitFor(() => expect(h.autonomyForAgent(h.sessions[0].config).fullFileAccess).toBe(true));
    expect(h.host.vscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
    expect(h.host.expectedAutonomySetting).toBeUndefined();
    const slow = fixture([agent('a')]);
    const entered = deferred(); const release = deferred(); let first = true;
    slow.host.updateUserAuthoritySetting.mockImplementation(async (key, value) => {
      slow.user[key] = value;
      if (first) { first = false; entered.resolve(undefined); await release.promise; }
    });
    const older = slow.setDefaultAutonomy('full-access');
    await entered.promise;
    slow.user.autonomy = 'workspace';
    slow.refreshAutonomyOnConfigurationChange(event);
    const nextAnswer = deferred();
    slow.host.vscode.window.showWarningMessage.mockReturnValue(nextAnswer.promise);
    slow.user.autonomy = 'full-access';
    slow.refreshAutonomyOnConfigurationChange(event);
    const newQuestions = slow.host.vscode.window.showWarningMessage.mock.calls.length;
    release.resolve(undefined); nextAnswer.resolve('Enable full access'); await older;
    expect(newQuestions).toBe(2);
    await vi.waitFor(() => expect(slow.autonomyForAgent(slow.sessions[0].config).fullFileAccess).toBe(true));
    const mismatch = fixture([agent('a')]);
    mismatch.host.updateUserAuthoritySetting.mockImplementation(async () => {});
    await mismatch.setDefaultAutonomy('full-access');
    expect(mismatch.values.get(AUTONOMY_DEFAULT_CONSENT_KEY)).not.toBe(true);
    expect(mismatch.defaults.effective('full-access')).toBe('workspace');
  });

  it('ignored workspace changes with unchanged User values do not invalidate, ask or mark a native turn pending', () => {
    const h = fixture([agent('a', { backend: 'codex', codexPermissionProfile: 'approve-for-me' })], 'full-access', true);
    h.turns.set('a', { id: 'unchanged-turn', mode: 'act' });
    h.refreshAutonomyOnConfigurationChange({ affectsConfiguration: (key: string) =>
      ['unode.autonomy', 'unode.commandApproval', 'unode.allowedCommands', 'unode.writeApproval'].includes(key) });
    expect(h.defaults.revision).toBe(0);
    expect(h.host.autonomyPolicyGeneration).toBe(0);
    expect(h.host.codexAutonomyPendingTurns.has('a')).toBe(false);
    expect(h.host.vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.autonomyForAgent(h.sessions[0].config).label).toBe('Full access');
  });

  it('actual native snapshots show a real pending difference and clear it when the live policy returns to the started policy', () => {
    const config = agent('a', { backend: 'codex', autonomyMode: 'review' });
    const h = fixture([config]);
    h.turns.set('a', { id: 'observed-turn', mode: 'act' });
    let current = 'ask-for-approval';
    h.host.codexNativePolicySnapshots.set('a', { turnId: 'observed-turn', profile: 'full-access', current: () => current });
    h.host.codexAutonomyPendingTurns.set('a', 'observed-turn');
    expect(h.autonomyForAgent(config).label).toBe('Custom · native Codex change pending');
    config.autonomyMode = 'full-access'; current = 'full-access';
    expect(h.autonomyForAgent(config).label).toBe('Full access');
    h.turns.set('a', { id: 'plan-task-turn', mode: 'plan', taskScoped: true });
    h.host.codexNativePolicySnapshots.set('a', { turnId: 'plan-task-turn', profile: 'read-only', current: () => 'read-only' });
    h.host.codexAutonomyPendingTurns.set('a', 'plan-task-turn');
    const capped = h.autonomyForAgent(config);
    expect(capped.label).not.toContain('native Codex change pending');
    expect(capped.limits).toContain('Plan is read only');
    expect(capped.limits).toContain('the current task narrows file access');
    h.host.codexNativePolicySnapshots.set('a', { turnId: 'old-turn', profile: 'full-access', current: () => { throw new Error('old getter'); } });
    h.turns.set('a', { id: 'next-turn', mode: 'act' });
    expect(h.autonomyForAgent(config).label).toBe('Full access');
  });
});

// v0.9.100 (the Owner, 2026-10-30): Autonomy is one menu in the chat input. Its selected position and every item's
// explanation come from the host; the menu never shows a lower position than the authority actually in force.
describe('actual extension: the chat input Autonomy menu', () => {
  const selectedItem = (menu: { selected: string; items: Array<{ mode: string; description: string }> }) =>
    menu.items.find(item => item.mode === menu.selected)!;

  it('offers exactly three positions in order, with the Codex names, each with its own explanation', () => {
    const h = fixture([agent('a')]);
    const menu = h.autonomyMenuForAgent(h.sessions[0].config, 'openai-compat');
    expect(menu.items.map(item => [item.mode, item.label])).toEqual([
      ['workspace', 'Approve for me'], ['review', 'Ask for approval'], ['full-access', 'Full access']]);
    expect(menu.selected).toBe('workspace');
    expect(new Set(menu.items.map(item => item.description)).size).toBe(3);
    expect(menu.items.find(item => item.mode === 'review')!.description).toContain('mediated writes use review');
    expect(menu.items.find(item => item.mode === 'full-access')!.description).toContain('Host file tools can reach files your OS account permits');
  });

  it('shows a saved native Codex Full access as Full access, with its implications, without changing it', () => {
    const config = agent('a', { backend: 'codex', codexPermissionProfile: 'full-access' });
    const h = fixture([config]);
    const menu = h.autonomyMenuForAgent(config, 'codex');
    expect(menu.selected).toBe('full-access');
    expect(selectedItem(menu).description).toContain("Codex's own saved setting: Full access. No sandbox and no approval prompts.");
    expect(menu.items.find(item => item.mode === 'workspace')!.description).not.toContain("Codex's own saved setting");
    expect(config.codexPermissionProfile).toBe('full-access');
    expect(config.autonomyMode).toBeUndefined();
  });

  it('says what native Codex runs with when the backend resolver caps it and no native turn is running', () => {
    const config = agent('a', { backend: 'codex', autonomyMode: 'full-access' });
    const h = fixture([config]);
    h.turns.set('a', { id: 'turn-1', mode: 'plan' });
    h.host.codexPermissionForAgent = () => ({ configured: 'full-access', effective: 'read-only', capReason: 'Plan mode is always read only.' });
    const menu = h.autonomyMenuForAgent(config, 'codex');
    expect(menu.selected).toBe('full-access');
    const description = selectedItem(menu).description;
    expect(description).toContain('Codex runs read only: Plan mode is always read only.');
    expect(description).not.toContain('This request runs');
    expect(description).not.toContain('Plan mode: read only.');
  });

  // Codex's audit of 1831cae2 (I2): the running request is described from its started native snapshot; the
  // resolver's projection is only ever called the next request's policy.
  it('describes a running native turn by its started policy and a narrower projection as the next request', () => {
    const config = agent('a', { backend: 'codex', autonomyMode: 'full-access' });
    const h = fixture([config]);
    h.turns.set('a', { id: 'turn-1', mode: 'act' });
    h.host.codexNativePolicySnapshots.set('a', { turnId: 'turn-1', profile: 'full-access', current: () => 'read-only' });
    h.host.codexPermissionForAgent = () => ({ configured: 'full-access', effective: 'read-only', capReason: 'Workspace Trust limits this agent to read only.' });
    const description = selectedItem(h.autonomyMenuForAgent(config, 'codex')).description;
    expect(description).toContain('This request runs as Full access.');
    expect(description).toContain('The next request runs read only: Workspace Trust limits this agent to read only.');
    expect(description).not.toContain('Codex runs read only');
  });

  it('describes a running turn that keeps its earlier choice, and the new choice as the next request', () => {
    const config = agent('a', { backend: 'codex', autonomyMode: 'full-access' });
    const h = fixture([config]);
    h.turns.set('a', { id: 'turn-1', mode: 'act' });
    h.host.codexNativePolicySnapshots.set('a', { turnId: 'turn-1', profile: 'ask-for-approval', current: () => 'full-access' });
    const description = selectedItem(h.autonomyMenuForAgent(config, 'codex')).description;
    expect(description).toContain('This request runs as Ask for approval.');
    expect(description).toContain('The next request runs as Full access.');
  });

  it('uses an unchanged read-only task snapshot for the running request', () => {
    const config = agent('a', { backend: 'codex' });
    const h = fixture([config]);
    h.turns.set('a', { id: 'turn-1', mode: 'act', taskScoped: true });
    h.host.codexNativePolicySnapshots.set('a', { turnId: 'turn-1', profile: 'read-only', current: () => 'read-only' });
    const description = selectedItem(h.autonomyMenuForAgent(config, 'codex')).description;
    expect(description).toContain('This request runs read only.');
    expect(description).toContain('This task limits file access.');
  });

  it('lists an independent stricter setting in plain words on the selected position only', () => {
    const config = agent('a', { backend: 'claude', autoApprove: false });
    const h = fixture([config]);
    // v0.9.101: the legacy autoApprove default is no one's choice and lists nothing; the person's own write Ask does.
    expect(selectedItem(h.autonomyMenuForAgent(config, 'claude')).description).not.toContain('Asks before file edits.');
    h.user.writeApproval = 'ask';
    const menu = h.autonomyMenuForAgent(config, 'claude');
    expect(menu.selected).toBe('workspace');
    expect(selectedItem(menu).description).toContain('Asks before file edits.');
    expect(menu.items.find(item => item.mode === 'full-access')!.description).not.toContain('Asks before file edits.');
    expect(JSON.stringify(menu)).not.toContain('Custom');
  });

  it('shows an unchanged agent the consent-checked default, and its own choice after one is made', async () => {
    const config = agent('a');
    const h = fixture([config], 'full-access', false);
    expect(h.autonomyMenuForAgent(config, 'openai-compat').selected).toBe('workspace');
    await h.setAgentAutonomy('a', 'review');
    expect(h.autonomyMenuForAgent(h.sessions[0].config, 'openai-compat').selected).toBe('review');
  });
});

// v0.9.102 R2 (design 2.1 B1, G2; Codex's audit of 123a870e): the OpenAI-compatible fixed prefix no longer carries the
// outside-path guidance, so the per-turn host text is its only route. This follows it from the actual host function,
// through the session manager's turn delivery, into the request the actual backend sends to the provider.
describe('the outside-path guidance reaches the actual OpenAI-compatible request (design 2.1 B1)', () => {
  it('carries it once per request from the host wiring, and a live Full access change replaces it on the next turn', async () => {
    // The production wiring is executed, not only read: the readScopeGuidance dependency the extension passes to its one
    // SessionManager, transpiled from extension.ts and bound to the actual host fileReachGuidance below.
    const constructions: ts.NewExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'SessionManager') constructions.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(constructions).toHaveLength(1);
    const deps = constructions[0].arguments?.[2];
    if (!deps || !ts.isObjectLiteralExpression(deps)) throw new Error('Missing the actual SessionManager dependencies');
    const wiring = deps.properties.filter((property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && property.name.getText(source) === 'readScopeGuidance');
    expect(wiring).toHaveLength(1);
    const wiringSource = ts.transpileModule(`return (${wiring[0].initializer.getText(source)});`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const fetchFn: FetchFn = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' } }] }) };
    };
    let host!: ReturnType<typeof fixture>;
    const bus = new MessageBus();
    const readScopeGuidance = new Function('fileReachGuidance', wiringSource)(
      (config: AgentConfig) => host.fileReachGuidance(config)) as (config: AgentConfig) => string;
    const manager = new SessionManager(5, bus, {
      createBackend: (config) => new OpenAICompatBackend(config, fetchFn),
      resolveEnv: async () => ({ ROAM_API_KEY: 'sk-test' }),
      readScopeGuidance,
    });
    manager.create(agent('a', { workingDirectory: process.cwd() }));
    // The host and the session manager hold the same agent, as in the extension: an Autonomy change is seen live.
    host = fixture([manager.get('a')!.config]);
    await manager.start('a', { pin: 'take' });

    const count = (text: string, part: string) => text.split(part).length - 1;
    // Each turn is awaited on its own end event, so there is no polling window shorter than the test's own time limit.
    const turn = async (instruction: string) => {
      const before = requests.length;
      const ended = new Promise<void>((resolve) => {
        const listener = (event: { sessionId: string }) => {
          if (event.sessionId !== 'a') return;
          manager.off('session.turnEnded', listener);
          resolve();
        };
        manager.on('session.turnEnded', listener);
      });
      bus.send('user', 'a', 'ask.question', { instruction, mode: 'act' });
      await ended;
      expect(requests.length).toBe(before + 1);
      const request = requests[requests.length - 1];
      const system = String(request.messages.find((message) => message.role === 'system')?.content ?? '');
      const all = request.messages.map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
      return { system, all };
    };

    try {
      // A normal trusted workspace: the guidance arrives once, from the host, and the fixed prefix carries none of it.
      const first = await turn('Update the report at C:/outside/report.md');
      expect(count(first.all, '## Paths outside the workspace (host setting)')).toBe(1);
      expect(count(first.all, 'A refused path blocks only the steps that need it')).toBe(1);
      expect(first.all).toContain('if it is refused, UnodeAi offers the user Grant access too.');
      expect(first.all).toContain('Do not tell them to open another folder as the workspace first.');
      expect(first.system).not.toMatch(/Grant access|A refused path blocks only/);

      // Full access is turned on for this agent: the next request says so, with no Grant access text left over.
      await host.setAgentAutonomy('a', 'full-access');
      const second = await turn('Now update C:/outside/summary.md');
      expect(count(second.all, 'Full access is on for you now')).toBe(1);
      expect(second.all).not.toMatch(/Grant access|## Paths outside the workspace|A refused path blocks only/);

      // Back to Workspace: the outside-path guidance returns, once.
      await host.setAgentAutonomy('a', 'workspace');
      const third = await turn('And C:/outside/notes.md');
      expect(count(third.all, '## Paths outside the workspace (host setting)')).toBe(1);
      expect(third.all).not.toContain('Full access is on for you now');
    } finally {
      await manager.stop('a');
    }
  });
});
