import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { readUnodeSetting } from '../AuthoritySettings';
import type { AgentConfig } from '../../types';
import { AutonomyDefaultConsent, AUTONOMY_DEFAULT_CONSENT_KEY, FULL_ACCESS_ACTION, resolveAutonomyPolicy,
  type AutonomyMode, type AutonomyPolicyInput } from '../AutonomyPolicy';

const files = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('vscode', () => ({
  Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/'), scheme: 'file' }) },
  workspace: { workspaceFolders: [], fs: {
    readFile: async (uri: { fsPath: string }) => {
      const bytes = files.get(uri.fsPath);
      if (!bytes) throw Object.assign(new Error('missing fixture'), { code: 'FileNotFound' });
      return bytes;
    },
  } },
  window: { showWarningMessage: vi.fn(), showInformationMessage: vi.fn(), showErrorMessage: vi.fn() },
}));
import { PersistenceManager } from '../../state/PersistenceManager';
import { applySavedPermissionRestore, type SavedPermissionRestoreSelection } from '../../state/SavedPermissionRestore';
import { AGENT_CONFIG_FIELD_AUTHORITY } from '../../state/TeamFileSchema';
import { contributedSettingProperties } from '../contributedSettings';

function agent(patch: Partial<AgentConfig> = {}): AgentConfig {
  return { id: 'dev', name: 'Developer', role: 'developer', skill: 'code-generation',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, model: 'deepseek-v4-flash',
    systemPrompt: 'Work on the task.', autoApprove: true, allowedTools: ['read', 'write', 'search', 'execute'],
    backend: 'openai-compat', ...patch };
}
function input(patch: Partial<AutonomyPolicyInput> = {}): AutonomyPolicyInput {
  return { config: agent(), backend: 'openai-compat', defaultMode: 'workspace', trusted: true,
    mode: 'act', commandMode: 'all', writeApproval: 'none', ...patch };
}
function memory(saved?: boolean) {
  const values = new Map<string, unknown>([['roam.messages', ['latest']], ['roam.runs', []], ['roam.workflows', []]]);
  if (saved !== undefined) values.set(AUTONOMY_DEFAULT_CONSENT_KEY, saved);
  return { values, get: <T>(key: string) => values.get(key) as T | undefined,
    update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }) };
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('one effective autonomy policy', () => {
  it('keeps the new setting application-scoped, restricted when untrusted and owned only by User settings', () => {
    const manifest = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const property = (contributedSettingProperties(manifest.contributes) as Record<string, any>)['unode.autonomy'];
    expect(property.scope).toBe('application');
    expect(property.default).toBe('workspace');
    expect(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations).toContain('unode.autonomy');
    const configuration = {
      get: <T>() => 'full-access' as T,
      inspect: <T>() => ({ defaultValue: 'workspace' as T, workspaceValue: 'full-access' as T, workspaceFolderValue: 'full-access' as T }),
    };
    expect(readUnodeSetting(configuration, 'autonomy', 'workspace')).toBe('workspace');
  });

  it('keeps Workspace automatic and makes Review deliberate without inventing another permission owner', () => {
    const workspace = resolveAutonomyPolicy(input());
    expect(workspace).toMatchObject({ choice: 'inherit', requested: 'workspace', label: 'Workspace',
      fullFileAccess: false, commandReview: false, writeReview: false, codexProfile: 'approve-for-me' });
    const review = resolveAutonomyPolicy(input({ defaultMode: 'review' }));
    expect(review).toMatchObject({ label: 'Review', fullFileAccess: false, commandReview: true, writeReview: true,
      codexProfile: 'ask-for-approval' });
    expect(resolveAutonomyPolicy(input({ defaultMode: 'review', commandMode: 'ask', writeApproval: 'ask' })).label).toBe('Review');
    const override = resolveAutonomyPolicy(input({ defaultMode: 'full-access', config: agent({ autonomyMode: 'workspace' }) }));
    expect(override).toMatchObject({ choice: 'workspace', requested: 'workspace', fullFileAccess: false });
  });

  it('gives Full access actual host-file scope only when trusted and without an independent folder scope', () => {
    expect(resolveAutonomyPolicy(input({ defaultMode: 'full-access' }))).toMatchObject({ fullFileAccess: true, label: 'Full access' });
    for (const patch of [{ trusted: false },
      { config: agent({ folderAccess: [{ path: path.resolve('reports'), permission: 'readwrite' }] }) }]) {
      const policy = resolveAutonomyPolicy(input({ defaultMode: 'full-access', ...patch }));
      expect(policy.fullFileAccess).toBe(false);
      expect(policy.label).toContain('Custom');
    }
    const plan = resolveAutonomyPolicy(input({ defaultMode: 'full-access', mode: 'plan' }));
    expect(plan.fullFileAccess).toBe(true); // Plan prohibits effects, not reading a permitted outside source.
    expect(plan.label).toContain('Custom');
    expect(plan.detail).toContain('Plan is read only');
    expect(plan.detail).toContain('changes are disabled');
  });

  it('keeps explicit Off, Ask, bounded tools and task-facing restrictions visible as Custom', () => {
    for (const patch of [
      { commandMode: 'none' as const }, { commandMode: 'ask' as const }, { commandMode: 'allowlist' as const },
      { writeApproval: 'ask' as const }, { config: agent({ executePreference: 'deny' }) },
      { config: agent({ toolCeiling: 'bounded', allowedTools: ['read'] }) },
      { backend: 'codex', config: agent({ toolCeiling: 'bounded', allowedTools: ['read'] }) },
      { backend: 'codex', config: agent({ toolCeiling: 'bounded', allowedTools: ['write'] }) },
      { config: agent({ commandNarrowing: { approvalMode: 'none' } }) },
    ]) {
      const policy = resolveAutonomyPolicy(input({ defaultMode: 'full-access', ...patch }));
      expect(policy.label).toContain('Custom');
      expect(policy.limits.length).toBeGreaterThan(0);
    }
    expect(resolveAutonomyPolicy(input({ defaultMode: 'full-access', writeApproval: 'ask' })).writeReview).toBe(true);
  });

  it('adds no review for Claude legacy autoApprove false, the value Create team gives every role (v0.9.101)', () => {
    const legacy = agent({ autoApprove: false });
    for (const defaultMode of ['workspace', 'full-access'] as const) {
      const policy = resolveAutonomyPolicy(input({ backend: 'claude', defaultMode, config: legacy }));
      expect(policy, defaultMode).toMatchObject({ writeReview: false, commandReview: false, limits: [] });
      expect(policy.label, defaultMode).not.toContain('Custom');
    }
    // What a person chose still reviews.
    expect(resolveAutonomyPolicy(input({ backend: 'claude', defaultMode: 'review', config: legacy })))
      .toMatchObject({ writeReview: true, commandReview: true });
    expect(resolveAutonomyPolicy(input({ backend: 'claude', writeApproval: 'ask', config: legacy })))
      .toMatchObject({ writeReview: true, limits: ['independent write review'] });
    expect(resolveAutonomyPolicy(input({ backend: 'claude', commandMode: 'ask', config: legacy })).limits)
      .toEqual(['independent command review or narrowing']);
  });

  it('shows a separately disabled host command tool as Custom without confining permitted Full file access', () => {
    for (const backend of ['openai-compat', 'claude']) {
      const policy = resolveAutonomyPolicy(input({ backend, defaultMode: 'full-access',
        config: agent({ allowedTools: ['read', 'write'] }) }));
      expect(policy.fullFileAccess).toBe(true);
      expect(policy.label).toContain('Custom');
      expect(policy.limits).toContain('Commands Off');
    }
    const native = resolveAutonomyPolicy(input({ backend: 'codex', defaultMode: 'full-access',
      config: agent({ toolCeiling: 'native-default', allowedTools: ['read', 'write'] }) }));
    expect(native.limits).not.toContain('Commands Off');
  });

  it('does not migrate ambiguous Codex defaults into Full access, but applies the new confirmed default', async () => {
    const state = memory();
    const defaults = new AutonomyDefaultConsent(state);
    const legacy = agent({ backend: 'codex', codexPermissionProfile: 'approve-for-me' });
    expect(resolveAutonomyPolicy(input({ backend: 'codex', config: legacy, defaultMode: defaults.effective('full-access') })))
      .toMatchObject({ codexProfile: 'approve-for-me', fullFileAccess: false });
    await defaults.choose('full-access', { trusted: () => true, confirm: async () => FULL_ACCESS_ACTION, write: async () => {} });
    expect(resolveAutonomyPolicy(input({ backend: 'codex', config: legacy, defaultMode: defaults.effective('full-access') })))
      .toMatchObject({ codexProfile: 'full-access', fullFileAccess: true });
  });

  it('preserves independent saved native Ask and Full choices until the per-agent Autonomy is deliberately changed', () => {
    for (const native of ['ask-for-approval', 'full-access'] as const) {
      for (const defaultMode of ['workspace', 'review', 'full-access'] as const) {
        expect(resolveAutonomyPolicy(input({ backend: 'codex', defaultMode,
          config: agent({ backend: 'codex', codexPermissionProfile: native }) })).codexProfile).toBe(native);
      }
      expect(resolveAutonomyPolicy(input({ backend: 'codex', defaultMode: 'full-access',
        config: agent({ backend: 'codex', codexPermissionProfile: native, autonomyMode: 'workspace' }) })).codexProfile).toBe('approve-for-me');
    }
    const custom = resolveAutonomyPolicy(input({ backend: 'codex', defaultMode: 'review',
      config: agent({ backend: 'codex', codexPermissionProfile: 'full-access' }) }));
    expect(custom.label).toContain('Custom');
    expect(custom.detail).toContain('Ask concerns escalation, not every ordinary edit');
    expect(custom.detail).toContain('native reads are not confined');
  });
});

describe('persisted Full access default consent', () => {
  it('requires an actual saved enable decision and leaves ordinary newer state rows alone', async () => {
    const state = memory();
    const owner = new AutonomyDefaultConsent(state);
    expect(owner.effective('full-access')).toBe('workspace');
    expect(owner.effective('administrator')).toBe('workspace');
    expect(owner.effective('review')).toBe('review');
    const confirm = vi.fn(async () => FULL_ACCESS_ACTION);
    const write = vi.fn(async (_mode: AutonomyMode) => {});
    expect(await owner.choose('full-access', { trusted: () => true, confirm, write })).toBe(true);
    expect(state.values.get(AUTONOMY_DEFAULT_CONSENT_KEY)).toBe(true);
    expect(state.values.get('roam.messages')).toEqual(['latest']);
    expect(write).toHaveBeenCalledWith('full-access');
    const restored = new AutonomyDefaultConsent(state);
    for (let start = 0; start < 4; start++) expect(restored.effective('full-access')).toBe('full-access');
    expect(confirm).toHaveBeenCalledTimes(1);
    owner.invalidate();
    expect(owner.effective('full-access')).toBe('workspace');
    expect(await owner.choose('workspace', { trusted: () => true, confirm, write })).toBe(true);
    expect(state.values.get(AUTONOMY_DEFAULT_CONSENT_KEY)).toBe(false);
  });

  it.each([undefined, 'Deny', 'Enable', true])('a declined or different answer (%s) never persists authority', async answer => {
    const state = memory(); const owner = new AutonomyDefaultConsent(state);
    const write = vi.fn(async () => {});
    expect(await owner.choose('full-access', { trusted: () => true, confirm: async () => answer, write })).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
    expect(owner.effective('full-access')).toBe('workspace');
  });

  it('does not offer an unusable Full access enable question in an untrusted workspace', async () => {
    const owner = new AutonomyDefaultConsent(memory());
    const confirm = vi.fn(async () => FULL_ACCESS_ACTION);
    expect(await owner.choose('full-access', { trusted: () => false, confirm, write: async () => {} })).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('trust loss, invalidate and the latest choice retire an unanswered enable', async () => {
    for (const end of ['trust', 'invalidate', 'latest'] as const) {
      const state = memory(); const owner = new AutonomyDefaultConsent(state); const answer = deferred<unknown>();
      const write = vi.fn(async (_mode: AutonomyMode) => {});
      let trusted = true;
      const pending = owner.choose('full-access', { trusted: () => trusted, confirm: () => answer.promise, write });
      if (end === 'trust') trusted = false;
      else if (end === 'invalidate') owner.invalidate();
      else await owner.choose('review', { trusted: () => true, confirm: async () => undefined, write });
      answer.resolve(FULL_ACCESS_ACTION);
      expect(await pending).toBe(false);
      expect(write.mock.calls.map(([mode]) => mode)).not.toContain('full-access');
      expect(owner.effective('full-access')).toBe('workspace');
    }
  });

  it('does not publish Full access after trust is lost during slow consent persistence', async () => {
    const state = memory(); const owner = new AutonomyDefaultConsent(state);
    const entered = deferred(); const release = deferred(); let trusted = true;
    state.update.mockImplementation(async (key, value) => {
      if (value === false) { entered.resolve(); await release.promise; }
      state.values.set(key, value);
    });
    const write = vi.fn(async () => {});
    const pending = owner.choose('full-access', { trusted: () => trusted, confirm: async () => FULL_ACCESS_ACTION, write });
    await entered.promise; trusted = false; release.resolve();
    expect(await pending).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(owner.effective('full-access')).toBe('workspace');
  });

  it('does not publish Full access after invalidate during slow consent persistence', async () => {
    const state = memory(); const owner = new AutonomyDefaultConsent(state);
    const entered = deferred(); const release = deferred();
    state.update.mockImplementation(async (key, value) => {
      if (value === false) { entered.resolve(); await release.promise; }
      state.values.set(key, value);
    });
    const write = vi.fn(async () => {});
    const pending = owner.choose('full-access', { trusted: () => true, confirm: async () => FULL_ACCESS_ACTION, write });
    await entered.promise; owner.invalidate(); release.resolve();
    expect(await pending).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(owner.effective('full-access')).toBe('workspace');
  });

  it('retires a slow setting write after trust loss or invalidate without saving Full access', async () => {
    for (const ending of ['trust', 'invalidate'] as const) {
      const state = memory(); const owner = new AutonomyDefaultConsent(state);
      const entered = deferred(); const release = deferred(); let trusted = true;
      const pending = owner.choose('full-access', { trusted: () => trusted, confirm: async () => FULL_ACCESS_ACTION,
        write: async () => { entered.resolve(); await release.promise; } });
      await entered.promise;
      if (ending === 'trust') trusted = false; else owner.invalidate();
      const effectiveWhileRetired = owner.effective('full-access');
      release.resolve();
      expect(await pending).toBe(false);
      expect(effectiveWhileRetired).toBe('workspace');
      expect(owner.effective('full-access')).toBe('workspace');
      expect(state.update.mock.calls.some(([, value]) => value === true)).toBe(false);
    }
  });

  it('cannot activate after trust loss or invalidate while the final enable record is persisting', async () => {
    for (const ending of ['trust', 'invalidate'] as const) {
      const state = memory(); const owner = new AutonomyDefaultConsent(state);
      const entered = deferred(); const release = deferred(); let trusted = true;
      state.update.mockImplementation(async (key, value) => {
        // Memento's in-memory value may change before its asynchronous persistence settles.
        state.values.set(key, value);
        if (value === true) { entered.resolve(); await release.promise; }
      });
      const write = vi.fn(async () => {});
      const pending = owner.choose('full-access', { trusted: () => trusted, confirm: async () => FULL_ACCESS_ACTION, write });
      await entered.promise;
      // The User setting can already be written, but the separately bound enable decision is not live.
      expect(write).toHaveBeenCalledWith('full-access');
      expect(owner.effective('full-access')).toBe('workspace');
      if (ending === 'trust') trusted = false; else owner.invalidate();
      release.resolve();
      expect(await pending).toBe(false);
      expect(state.values.get(AUTONOMY_DEFAULT_CONSENT_KEY)).toBe(false);
      expect(owner.effective('full-access')).toBe('workspace');
    }
  });

  it('serializes a newer default choice behind a slow setting write without reviving the old authority', async () => {
    const state = memory(); const owner = new AutonomyDefaultConsent(state);
    const entered = deferred(); const release = deferred(); const writes: string[] = [];
    let configured: AutonomyMode = 'review';
    const older = owner.choose('full-access', { trusted: () => true, confirm: async () => FULL_ACCESS_ACTION,
      write: async mode => { entered.resolve(); await release.promise; configured = mode; writes.push(mode); } });
    await entered.promise;
    const newer = owner.choose('workspace', { trusted: () => true, confirm: async () => undefined,
      write: async mode => { configured = mode; writes.push(mode); } });
    const effectiveWhileSuperseded = owner.effective('full-access');
    try {
      // Let an independent save have a complete event-loop turn to finish while the earlier storage write is
      // deliberately held. A newer setting must not be persisted first and then overwritten by that old write.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(configured).toBe('review');
      expect(writes).toEqual([]);
      expect(owner.effective(configured)).toBe('review');
    } finally { release.resolve(); }
    expect(await older).toBe(false);
    expect(await newer).toBe(true);
    expect(effectiveWhileSuperseded).toBe('workspace');
    expect(writes).toEqual(['full-access', 'workspace']);
    expect(configured).toBe('workspace');
    expect(owner.effective(configured)).toBe('workspace');
    expect(state.values.get(AUTONOMY_DEFAULT_CONSENT_KEY)).toBe(false);
  });

  it('a failed setting save cannot leave the Full access enable decision behind', async () => {
    const state = memory(); const owner = new AutonomyDefaultConsent(state);
    await expect(owner.choose('full-access', { trusted: () => true, confirm: async () => FULL_ACCESS_ACTION,
      write: async () => { throw new Error('storage unavailable'); } })).rejects.toThrow('storage unavailable');
    expect(owner.effective('full-access')).toBe('workspace');
  });
});

describe('host-only autonomy provenance through the real persistence reader', () => {
  beforeEach(() => files.clear());
  it('cannot launder a hostile team override through automatic save, team-file removal and reload', async () => {
    const state = memory(); const workspaceRoot = path.resolve('autonomy-policy-fixture');
    const uri = `${workspaceRoot}/.unode/team.json`;
    files.set(uri, Buffer.from(JSON.stringify({ members: [agent({ autonomyMode: 'full-access' })] })));
    const context = { workspaceState: state } as never;
    const persistence = new PersistenceManager(context, undefined, () => workspaceRoot);
    const document = await persistence.loadTeamConfig();
    expect(AGENT_CONFIG_FIELD_AUTHORITY.autonomyMode).toBe('host-only');
    expect(document?.members).toHaveLength(1);
    expect(document!.members[0].autonomyMode).toBeUndefined();
    await persistence.saveAgents(document!.members);
    files.delete(uri);
    const reloaded = new PersistenceManager(context, undefined, () => workspaceRoot).loadAgents();
    expect(reloaded[0].autonomyMode).toBeUndefined();
    expect(resolveAutonomyPolicy(input({ config: reloaded[0] })).fullFileAccess).toBe(false);
  });

  it('does not restore an injected autonomy field through a saved permission selection', () => {
    const current = agent({ autonomyMode: 'review' });
    const selection: SavedPermissionRestoreSelection = { skillIds: [], skills: [], allowedTools: ['read', 'write'],
      playbooks: [], backendKind: 'openai-compat' };
    // @ts-expect-error A saved-team permission form has no host-only Autonomy field.
    selection.autonomyMode = 'full-access';
    applySavedPermissionRestore(current, selection);
    expect(current.autonomyMode).toBe('review');
    const inheriting = agent();
    applySavedPermissionRestore(inheriting, selection);
    expect(inheriting.autonomyMode).toBeUndefined();
  });

  it('the actual saved permission selection type cannot carry the host-only field', async () => {
    const ts = await import('typescript');
    const virtualFile = path.resolve('src/state/__autonomy_permission_type_proof__.ts');
    const text = `import type { SavedPermissionRestoreSelection } from './SavedPermissionRestore';
      const selection: SavedPermissionRestoreSelection = {
        skillIds: [], skills: [], allowedTools: [], playbooks: [], backendKind: 'claude', autonomyMode: 'full-access'
      };`;
    const options = { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16,
      types: ['node', 'vscode'] };
    const host = ts.createCompilerHost(options);
    const sourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) =>
      path.resolve(file) === virtualFile ? ts.createSourceFile(file, text, languageVersion, true)
        : sourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram([virtualFile], options, host);
    const source = program.getSourceFile(virtualFile)!;
    const diagnostics = program.getSemanticDiagnostics(source);
    expect(diagnostics.some(diagnostic => diagnostic.code === 2353
      && ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ').includes('autonomyMode'))).toBe(true);
  }, 30_000);
});
