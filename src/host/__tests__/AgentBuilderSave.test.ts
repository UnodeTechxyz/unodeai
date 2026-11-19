import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { AgentConfigBuilder, ROLE_TEMPLATES, SKILL_LIBRARY } from '../../roles/RoleConfig';
import { SkillResolver } from '../../roles/SkillResolver';
import { agentBuilderTools, builderCarriesInstanceTools } from '../../roles/AgentBuilderTools';
import { AgentRosterEdits } from '../AgentRosterEdits';
import type { AgentBuilderSavePayload } from '../../views/AgentBuilderPanel';
import type { AgentConfig } from '../../types';
import { applySavedPermissionRestore, savedCommandPreference, restoredCommandTools, type SavedCommandPreference } from '../../state/SavedPermissionRestore';
import { isExecutePreference } from '../../roles/BuiltinToolDefaults';
import { describeAgentBuilderSaveProblem, parseAgentBuilderSavePayload, renderAgentBuilderHtml, type AgentBuilderViewModel } from '../../views/AgentBuilderPanel';
import { parseSkillCatalog } from '../../marketplace/catalog';
import { bootWebviewScript } from '../../views/__tests__/support/webviewBoot';
import * as vscode from 'vscode';
import { PersistenceManager } from '../../state/PersistenceManager';
import type { TeamFileDocument } from '../../state/TeamFileSchema';
import { agentExecutionChanged } from '../../session/agentExecutionChange';
import {
  BUILTIN_CONNECTION_REGISTRY, connectionIdForProviderId, providerRefForConnectionId, routeForConnectionId,
} from '../../routes/ConnectionRegistry';

// A small in-memory project folder, so the custom-role round trip below can use the real PersistenceManager.
const disk = vi.hoisted(() => ({ files: new Map<string, Uint8Array>() }));
vi.mock('vscode', () => ({
  window: { showWarningMessage: vi.fn() },
  Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }),
    joinPath: (uri: { fsPath: string }, ...parts: string[]) => ({ fsPath: [uri.fsPath, ...parts].join('/'), scheme: 'file' }) },
  workspace: { workspaceFolders: [{ uri: { fsPath: '/workspace', scheme: 'file' } }], fs: {
    readFile: vi.fn(async (uri: { fsPath: string }) => {
      const bytes = disk.files.get(uri.fsPath); if (!bytes) throw Object.assign(new Error('missing'), { code: 'FileNotFound' }); return bytes;
    }),
    createDirectory: vi.fn(async () => {}),
    writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => { disk.files.set(uri.fsPath, Buffer.from(bytes)); }),
  } },
}));

const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
function declaration(name: string) {
  const node = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!node) throw new Error(`Missing actual ${name}`);
  return ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

/** Run the actual extension handler (not a mirrored save algorithm); all I/O and restart hooks are fakes. */
function fixture(current?: AgentConfig, backendKind = 'openai-compat') {
  const sessions = current ? [{ id: current.id, config: current, status: 'stopped' }] : [];
  let revision = 0; const writes: AgentConfig[][] = [];
  const persist = vi.fn(async (rows: AgentConfig[]) => { writes.push(structuredClone(rows)); });
  const agentRosterEdits = new AgentRosterEdits({ members: () => sessions.map(s => s.config), revision: () => revision,
    currentWorkspace: () => true, persist });
  const sessionManager = { get: (id: string) => sessions.find(s => s.id === id), getAll: () => sessions,
    configEdited: vi.fn(async () => {}), restart: vi.fn(async () => {}), prepareToolRevocation: vi.fn(async () => {}),
    create: vi.fn((config: AgentConfig) => { sessions.push({ id: config.id, config, status: 'stopped' }); revision++; }) };
  const capabilities = { skills: true, playbooks: true, mcp: true, modelParams: new Set() };
  const host = {
    agentRosterEdits, agentBuilderTools, isExecutePreference, sessionManager, hostShutdown: { started: false }, effectiveConnectionRegistry: {}, ROLE_TEMPLATES, SKILL_LIBRARY,
    applySavedPermissionRestore, savedCommandPreference, restoredCommandTools, shouldRestartAfterAgentConfigEdit: () => false,
    skillResolver: new SkillResolver(SKILL_LIBRARY), AgentConfigBuilder,
    connectionIdForProviderId: () => 'roam', providerRefForConnectionId: () => ({ providerId: 'roam' }),
    connectionProfile: () => ({ availability: 'available', backendKind, kind: 'openai-compatible',
      presentation: { displayName: 'Test', endpointDefault: 'https://example.invalid' }, capabilities }),
    dropUnsupportedGrants: (selection: unknown) => ({ selection }), loadMarketplaceCatalog: async () => ({ skills: [] }),
    applyPlaybooks: (prompt: string) => prompt, defaultBackendKind: () => 'openai-compat',
    unsupportedModelParamKeys: () => [], supportedModelParams: () => undefined,
    routeForConnectionId: () => ({ test: true }), capabilityViolations: () => [],
    recordSystemPromptSave: (config: AgentConfig, prompt: string) => { config.systemPrompt = prompt; },
    migratePromptTemplateSource: () => {}, recordCustomRoleSave: () => {}, retainReplacedPrompt: () => {},
    iconForSavedAgent: () => 'A', rosterIcons: () => [], mcpRegistry: new Map(),
    discoveredContextWindow: () => undefined, decideContextWindowMeasurement: () => ({ applied: false }),
    scheduleTeamRulesOnRosterChange: vi.fn(), teamViewProvider: { refresh: vi.fn() }, chatViewProvider: { refresh: vi.fn() },
    MarketplacePanel: { refreshCurrent: vi.fn() }, notifyPmRosterChange: vi.fn(), backendKindChangeNotice: () => '',
    // v0.9.101 (H2a audit H2a-1): the real comparison, as the extension imports it.
    agentExecutionChanged,
    // v0.9.101 (the access table): an agent edit re-judges its rows.
    accessInputsChanged: () => undefined,
  };
  const save = new Function('host', `with (host) { ${declaration('handleAgentBuilderSave')}; return handleAgentBuilderSave; }`)(host) as
    (payload: AgentBuilderSavePayload, uri: unknown, isCurrent?: () => boolean, preference?: SavedCommandPreference,
      sourceCurrent?: () => Promise<boolean>) => Promise<{ ok: boolean; message: string }>;
  const payload: AgentBuilderSavePayload = { ...(current ? { id: current.id } : {}), name: 'Edited contract agent', roleKey: 'contract-analyst',
    providerId: 'roam', model: 'test-model', systemPrompt: 'Edited instructions', skillIds: ['documentation'], playbooks: [], mcpServers: [] };
  return { save: (isCurrent?: () => boolean, preference?: SavedCommandPreference, sourceCurrent?: () => Promise<boolean>) =>
    save(payload, {}, isCurrent, preference, sourceCurrent), payload, sessions, persist, writes, host };
}

describe('actual Agent Builder save boundary', () => {
  it('a custom agent can remove its command skill through the ordinary save lane', async () => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setAllowedTools(['read', 'execute', 'write']).build();
    delete current.roleTemplateKey; delete current.executePreference;
    // v0.9.102: the agent's command came from its Testing skill. A tool no skill gave it is its own and stays (design 3.3).
    current.skills = [SKILL_LIBRARY.testing];
    const h = fixture(current); Object.assign(h.payload, { roleKey: 'custom', customRole: 'Writer', skillIds: ['documentation'] });
    const result = await h.save(); expect(result.ok).toBe(true);
    expect(h.sessions[0].config.allowedTools).not.toContain('execute');
    expect(h.host.sessionManager.prepareToolRevocation).not.toHaveBeenCalled(); expect(h.persist).toHaveBeenCalledOnce();
    expect(h.host.sessionManager.configEdited).toHaveBeenCalledOnce();
  });
  it('the actual recovery port keeps the saved team with its unsaved Off when no team file exists', async () => {
    const statement = source.statements.find(node => ts.isVariableStatement(node)
      && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === 'agentRosterEdits'))!;
    const code = ts.transpileModule(statement.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const saved = new AgentConfigBuilder().fromTemplate('contract-analyst').setId('saved').build();
    const live = structuredClone(saved); const publish = vi.fn(async () => {});
    const host = { AgentRosterEdits, teamRosterRevision: 0, workspaceBinding: { isStale: () => false },
      sessionManager: { getAll: () => [{ config: live }], prepareRosterReplacement: vi.fn(async () => {}), publishStoppedRoster: publish },
      persistence: { loadTeamConfig: vi.fn(async () => undefined), loadAgents: () => [saved], saveAgents: vi.fn(async () => { throw new Error('disk'); }) }, showResultNotice: vi.fn() };
    const editor = new Function('host', `with (host) { ${code}; return agentRosterEdits; }`)(host) as AgentRosterEdits;
    const off = { ...saved, allowedTools: ['read'], executePreference: 'deny' as const, builtinToolDefaultsRevision: 1 as const };
    await expect(editor.revokeCommands(off, live, () => true, async () => {}, () => {})).rejects.toThrow('disk');
    editor.requireRecovery(); await expect(editor.save()).rejects.toThrow('disk');
    expect(publish).toHaveBeenCalledWith([expect.objectContaining({ id: 'saved', executePreference: 'deny', allowedTools: expect.not.arrayContaining(['execute']) })]);
    expect(host.showResultNotice).toHaveBeenCalledWith('warning', expect.stringContaining('There is no team file'));
    expect(host.showResultNotice).not.toHaveBeenCalledWith('warning', expect.stringContaining('reloaded the team from the file'));
  });
  it.each(['template', 'allow', 'deny'] as const)('trusted %s saved preference changes only execute beyond a saved read-only cap', async preference => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setAllowedTools(['read']).build();
    delete current.executePreference; delete current.builtinToolDefaultsRevision;
    const desired = { ...current, executePreference: preference }; const h = fixture(current);
    Object.assign(h.payload, { permissionRestoreOnly: true, allowedToolCeiling: ['read'] });
    expect((await h.save(undefined, savedCommandPreference(desired, true), async () => true)).ok).toBe(true);
    expect(h.sessions[0].config.allowedTools).toEqual(preference === 'deny' ? ['read'] : ['execute', 'read']);
    expect(h.sessions[0].config.executePreference).toBe(preference); expect(h.writes[0][0]).toEqual(h.sessions[0].config);
  });
  it('unrecognised declarations cannot acquire the trusted preference exception through permissionRestoreOnly', async () => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setAllowedTools(['read']).build();
    delete current.executePreference; const h = fixture(current);
    Object.assign(h.payload, { permissionRestoreOnly: true, allowedToolCeiling: ['read'], executePreference: 'allow' });
    const forged = { ...current, executePreference: 'allow' as const };
    expect((await h.save(undefined, savedCommandPreference(forged, false))).ok).toBe(true);
    expect(h.sessions[0].config.allowedTools).toEqual(['read']); expect(h.sessions[0].config.executePreference).toBeUndefined();
  });
  it('revalidates the exact source after storage and compensates rather than publishing a stale grant', async () => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setAllowedTools(['read']).build(); delete current.executePreference;
    const h = fixture(current); Object.assign(h.payload, { permissionRestoreOnly: true, allowedToolCeiling: ['read'] });
    const source = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await h.save(undefined, savedCommandPreference({ ...current, executePreference: 'allow' }, true), source)).ok).toBe(false);
    expect(h.sessions[0].config).toBe(current); expect(current.allowedTools).toEqual(['read']); expect(h.persist).toHaveBeenCalledTimes(2);
    expect(h.writes.at(-1)?.[0]).toEqual(current); expect(h.host.sessionManager.restart).not.toHaveBeenCalled();
  });
  function form(h: ReturnType<typeof fixture>) {
    const current = h.sessions[0].config;
    const view: AgentBuilderViewModel = { mode: 'edit', agent: { id: current.id, name: current.name, role: current.role,
      roleKey: 'contract-analyst', roleLabel: current.role, providerId: 'roam', model: 'test-model', systemPrompt: 'Keep instructions',
      skillIds: ['documentation'], playbooks: [], mcpServers: [], savedTools: current.allowedTools, executePreference: current.executePreference },
      roles: [{ id: 'contract-analyst', name: 'Contract Analyst', role: 'custom', systemPrompt: 'Role instructions',
        skillIds: ['documentation'], playbookIds: [], model: 'test-model', providerId: 'roam', commandToolDefaults: { deniedTools: ['delegate'] } },
      { id: 'content-strategist', name: 'Content Strategist', role: 'custom', systemPrompt: 'Write content',
        skillIds: ['documentation'], playbookIds: [], model: 'test-model', providerId: 'roam', commandToolDefaults: { deniedTools: ['delegate'] } }],
      providers: [{ id: 'roam', name: 'Test', models: [{ id: 'test-model', name: 'Test' }] }],
      capabilities: [{ id: 'documentation', name: 'Documentation', category: 'documentation', description: 'Write', requiredTools: ['read', 'write', 'execute'] }],
      mcpServers: [], catalog: { agents: [], skills: [], mcp: [] }, skillLibraryUrl: '' };
    const box = { checked: true, dataset: { capabilityId: 'documentation', capabilityTools: 'read,write,execute' }, closest: () => null };
    const boot = bootWebviewScript(renderAgentBuilderHtml({ cspSource: 'test:' } as never, view), {
      document: { querySelectorAll: selector => selector.includes('data-capability-id') ? [box] : [] },
    });
    for (const [id, value] of Object.entries({ role: 'contract-analyst', name: 'Edited contract agent', provider: 'roam',
      model: 'test-model', systemPrompt: 'Keep instructions', toolProtocol: 'auto' })) {
      if (!boot.elements.has(id)) boot.elements.set(id, { ...boot.elements.get('role')! });
      boot.elements.get(id)!.value = value;
    }
    const change = (id: string) => {
      const target = boot.elements.get(id)!; target.id = id;
      for (const handler of boot.listeners.change ?? []) handler({ target });
    };
    const saveForm = () => {
      for (const handler of boot.listeners.click ?? []) handler({ target: { closest: (selector: string) => selector === '#saveButton' ? {} : null } });
      const message = boot.postedMessages.find((value: any) => value.command === 'save') as { payload: unknown };
      expect(message).toBeDefined(); return { raw: message.payload as Record<string, unknown>, parsed: parseAgentBuilderSavePayload(message.payload, view) };
    };
    return { boot, change, saveForm };
  }
  it.each(['template', 'allow', 'deny'] as const)('rendered Run commands %s -> real webview message -> parser -> actual host -> storage', async preference => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setAllowedTools(['read']).build();
    delete current.executePreference; delete current.builtinToolDefaultsRevision;
    const h = fixture(current); const page = form(h); page.boot.elements.get('executePreference')!.value = preference;
    page.change('executePreference'); const submitted = page.saveForm();
    expect(submitted.parsed?.executePreference).toBe(preference); expect(submitted.raw).not.toHaveProperty('builtinToolDefaultsRevision');
    Object.assign(h.payload, submitted.parsed); expect((await h.save()).ok).toBe(true);
    expect(h.writes[0][0].executePreference).toBe(preference);
    expect(h.sessions[0].config.allowedTools?.includes('execute')).toBe(preference !== 'deny');
  });
  it('untouched legacy form submits no command answer even when its capability checkbox includes execute', async () => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setAllowedTools(['read']).build();
    delete current.executePreference; delete current.builtinToolDefaultsRevision;
    const h = fixture(current); const page = form(h); expect(page.boot.elements.get('executePreference')!.value).toBe('');
    const submitted = page.saveForm(); expect(submitted.raw).not.toHaveProperty('executePreference');
    Object.assign(h.payload, submitted.parsed); expect((await h.save()).ok).toBe(true);
    expect(h.sessions[0].config.executePreference).toBeUndefined(); expect(h.sessions[0].config.allowedTools).not.toContain('execute');
  });
  it('builtin-to-builtin role selection keeps an unchosen command ceiling exactly as the form previews', async () => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setAllowedTools(['read', 'write']).build();
    delete current.executePreference; delete current.builtinToolDefaultsRevision;
    const h = fixture(current); const page = form(h);
    page.boot.elements.get('role')!.value = 'content-strategist'; page.change('role');
    expect(page.boot.elements.get('executePreference')!.value).toBe('');
    const submitted = page.saveForm(); expect(submitted.parsed).toBeDefined();
    expect(submitted.raw).not.toHaveProperty('executePreference');
    Object.assign(h.payload, submitted.parsed); expect((await h.save()).ok).toBe(true);
    expect(h.writes[0][0].allowedTools).not.toContain('execute');
    expect(h.sessions[0].config.executePreference).toBeUndefined();
  });
  it.each(['native-default', undefined] as const)('moving legacy Codex %s to another connection preserves effective command authority without inventing consent', async toolCeiling => {
    for (const backend of ['claude', 'openai-compat']) {
      const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setProviderById('codex').build();
      Object.assign(current, { backend: 'codex', toolCeiling, allowedTools: [] });
      delete current.executePreference; delete current.builtinToolDefaultsRevision;
      const h = fixture(current, backend);
      expect((await h.save()).ok).toBe(true);
      expect(h.writes[0][0].allowedTools).toContain('execute');
      expect(h.sessions[0].config.executePreference).toBeUndefined();
    }
  });
  it('the rendered preview names template-supplied commands and the Off control rather than unticking a skill', () => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setAllowedTools(['read']).build();
    delete current.executePreference; const page = form(fixture(current));
    page.boot.elements.get('executePreference')!.value = 'template'; page.change('executePreference');
    expect(page.boot.elements.get('toolWidening')!.textContent).toContain('choose Off in Run commands');
    page.boot.elements.get('executePreference')!.value = 'deny'; page.change('executePreference');
    expect(page.boot.elements.get('toolWidening')!.textContent).not.toContain('Run commands.');
  });
  it('a roster replacement during catalog loading refuses the original form even with the same agent ID', async () => {
    const h = fixture(new AgentConfigBuilder().fromTemplate('contract-analyst').build());
    h.host.loadMarketplaceCatalog = async () => { h.sessions[0].config = structuredClone(h.sessions[0].config); return { skills: [] }; };
    expect((await h.save()).ok).toBe(false); expect(h.persist).not.toHaveBeenCalled();
  });
  it.each(['template', 'allow', 'deny'] as const)('explicit %s intent reaches the actual host save, not just a helper', async preference => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setAllowedTools(['read']).build();
    delete current.executePreference; delete current.builtinToolDefaultsRevision;
    const h = fixture(current); h.payload.executePreference = preference;
    expect((await h.save()).ok).toBe(true);
    expect(h.sessions[0].config.executePreference).toBe(preference);
    expect(h.sessions[0].config.allowedTools?.includes('execute')).toBe(preference !== 'deny');
    expect(h.writes[0][0]).toEqual(h.sessions[0].config);
    expect(h.host.sessionManager.prepareToolRevocation).not.toHaveBeenCalled(); // No execute existed to narrow.
  });
  it('failed explicit Off keeps the live narrow choice and permits an untouched reopened form to persist Off', async () => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').build(); const h = fixture(current);
    h.payload.executePreference = 'deny'; h.persist.mockRejectedValueOnce(new Error('disk failed'));
    const failed = await h.save(); expect(failed.ok).toBe(false); expect(failed.message).toContain('it could not be saved yet');
    expect(current.allowedTools).not.toContain('execute'); expect(current.executePreference).toBe('deny');
    expect(h.host.agentRosterEdits.admissionAllowed).toBe(true);
    await expect(h.host.agentRosterEdits.replace(h.host.agentRosterEdits.capture(), async () => {})).resolves.toBeUndefined();
    expect(h.host.sessionManager.configEdited).not.toHaveBeenCalled();
    delete h.payload.executePreference; // A reopened Builder still displays the live Off choice without a new choice.
    expect((await h.save()).ok).toBe(true); expect(h.host.agentRosterEdits.admissionAllowed).toBe(true);
    expect(h.writes.at(-1)?.[0].executePreference).toBe('deny');
  });
  it('failed explicit On never grants execute to the running record', async () => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setExecutePreference('deny').build();
    const h = fixture(current); h.payload.executePreference = 'allow'; h.persist.mockRejectedValueOnce(new Error('grant failed'));
    await expect(h.save()).rejects.toThrow('grant failed'); expect(current.allowedTools).not.toContain('execute');
    expect(current.executePreference).toBe('deny'); expect(h.host.sessionManager.configEdited).not.toHaveBeenCalled();
  });
  it('an Off save interrupted by shutdown retains only the narrow live choice, not the rest of the stale form', async () => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').build(); const name = current.name;
    const h = fixture(current); h.payload.executePreference = 'deny';
    h.persist.mockImplementationOnce(async () => { h.host.hostShutdown.started = true; });
    expect((await h.save()).ok).toBe(false); expect(current.name).toBe(name); expect(current.executePreference).toBe('deny');
    expect(h.host.agentRosterEdits.admissionAllowed).toBe(true); expect(h.host.sessionManager.configEdited).not.toHaveBeenCalled();
    expect(h.persist).toHaveBeenCalledTimes(2);
  });
  it('refuses explicit Off on native Codex before mutating or saving anything', async () => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setProviderById('codex').build();
    current.backend = 'codex'; current.toolCeiling = 'native-default'; current.allowedTools = [];
    const before = structuredClone(current); const h = fixture(current, 'codex'); h.payload.executePreference = 'deny';
    expect((await h.save()).ok).toBe(false); expect(current).toEqual(before); expect(h.persist).not.toHaveBeenCalled();
    expect(h.host.sessionManager.prepareToolRevocation).not.toHaveBeenCalled();
  });
  it.each(['custom', 'contract-analyst'])('host rejects forged command preference for %s', async roleKey => {
    const h = fixture(); h.payload.roleKey = roleKey; h.payload.customRole = 'Custom';
    h.payload.executePreference = (roleKey === 'custom' ? 'template' : 'already-approved') as never;
    expect((await h.save()).ok).toBe(false); expect(h.persist).not.toHaveBeenCalled();
  });
  it('actual host roster lane uses live members, the existing roster revision and workspace binding, and the real persistence port', async () => {
    const statement = source.statements.find(node => ts.isVariableStatement(node)
      && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === 'agentRosterEdits'));
    if (!statement) throw new Error('Missing actual roster editor binding');
    const code = ts.transpileModule(statement.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const member = new AgentConfigBuilder().fromTemplate('contract-analyst').build();
    const host = { AgentRosterEdits, teamRosterRevision: 0, sessionManager: { getAll: () => [{ config: member }] },
      workspaceBinding: { isStale: () => false }, persistence: { saveAgents: vi.fn(async () => {}) } };
    const editor: AgentRosterEdits = new Function('host', `with (host) { ${code}; return agentRosterEdits; }`)(host);
    await new Function('agentRosterEdits', `${declaration('saveRoster')}; return saveRoster();`)(editor);
    expect(host.persistence.saveAgents).toHaveBeenCalledExactlyOnceWith([member]);
    const current = editor.capture(); host.teamRosterRevision++; expect(current()).toBe(false);
    host.workspaceBinding.isStale = () => true;
    await expect(editor.save()).rejects.toThrow('workspace changed'); expect(host.persistence.saveAgents).toHaveBeenCalledTimes(1);
  });
  it.each(['template', 'allow', 'deny', undefined] as const)('ordinary name/model/prompt/skill edits preserve command preference %s', async preference => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setId('contract').build();
    if (preference) Object.assign(current, new AgentConfigBuilder().fromTemplate('contract-analyst').setExecutePreference(preference).setId(current.id).build());
    else { delete current.executePreference; delete current.builtinToolDefaultsRevision; current.allowedTools = ['read']; }
    const before = structuredClone(current); const h = fixture(current);
    h.persist.mockImplementationOnce(async rows => {
      expect(h.sessions[0].config).toBe(current); expect(current).toEqual(before);
      expect(h.host.sessionManager.configEdited).not.toHaveBeenCalled(); h.writes.push(structuredClone(rows));
    });
    expect((await h.save()).ok).toBe(true);
    expect(h.sessions[0].config).toMatchObject({ name: h.payload.name, model: 'test-model', systemPrompt: h.payload.systemPrompt });
    expect(h.sessions[0].config.executePreference).toBe(preference);
    expect(h.sessions[0].config.allowedTools?.includes('execute')).toBe(preference === 'template' || preference === 'allow');
    expect(h.writes[0][0]).toEqual(h.sessions[0].config); expect(current).toEqual(before);
    expect(h.host.sessionManager.configEdited).toHaveBeenCalledExactlyOnceWith(current.id, { backendKindChanged: false, executionChanged: true });
    if (preference === 'deny') expect(h.host.sessionManager.prepareToolRevocation).not.toHaveBeenCalled();
  });
  it('the actual host recovery port reads the current file and publishes that team, not a frozen old roster', async () => {
    const statement = source.statements.find(node => ts.isVariableStatement(node)
      && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === 'agentRosterEdits'))!;
    const code = ts.transpileModule(statement.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const actual = new AgentConfigBuilder().fromTemplate('contract-analyst').setId('on-disk').build();
    const read = vi.fn(async () => ({ members: [actual] })); const publish = vi.fn(async () => {});
    const host = { AgentRosterEdits, teamRosterRevision: 0, workspaceBinding: { isStale: () => false },
      sessionManager: { getAll: () => [], prepareRosterReplacement: vi.fn(async () => {}), publishStoppedRoster: publish },
      persistence: { loadTeamConfig: read, saveAgents: vi.fn(async () => {}) }, showResultNotice: vi.fn() };
    const editor = new Function('host', `with (host) { ${code}; return agentRosterEdits; }`)(host) as AgentRosterEdits;
    editor.requireRecovery(); await editor.save();
    expect(read).toHaveBeenCalledWith({ strict: true }); expect(publish).toHaveBeenCalledWith([actual]);
    expect(editor.admissionAllowed).toBe(true);
    expect(host.showResultNotice).toHaveBeenCalledWith('warning', expect.stringContaining('reloaded the team'));
  });
  it('failed persistence cannot mutate or restart the active agent', async () => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').build(); const before = structuredClone(current);
    const h = fixture(current); h.persist.mockRejectedValueOnce(new Error('disk failure'));
    await expect(h.save()).rejects.toThrow('disk failure'); expect(current).toEqual(before);
    expect(h.sessions[0].config).toBe(current); expect(h.host.sessionManager.configEdited).not.toHaveBeenCalled();
  });
  it('a new builtin has the template command default in storage before its creation event', async () => {
    const h = fixture(); h.host.sessionManager.create.mockImplementationOnce(config => {
      expect(h.writes[0][0]).toEqual(config); expect(config.allowedTools).toContain('execute');
      expect(config.executePreference).toBe('template');
    });
    expect((await h.save()).ok).toBe(true); expect(h.host.sessionManager.create).toHaveBeenCalledOnce();
  });
  it('does not create a new agent after failed storage or a removed edit target', async () => {
    const h = fixture(); h.persist.mockRejectedValueOnce(new Error('disk failure'));
    await expect(h.save()).rejects.toThrow('disk failure'); expect(h.host.sessionManager.create).not.toHaveBeenCalled();
    h.payload.id = 'gone'; expect((await h.save()).ok).toBe(false); expect(h.persist).toHaveBeenCalledTimes(1);
  });
  it('an unrelated roster mutation during save refuses the stale edit and repairs storage from the actual roster', async () => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').build(); const h = fixture(current);
    h.persist.mockImplementationOnce(async rows => { h.writes.push(structuredClone(rows)); current.name = 'newer edit'; });
    expect((await h.save()).ok).toBe(false); expect(h.sessions[0].config).toBe(current); expect(current.name).toBe('newer edit');
    expect(h.writes.at(-1)?.[0].name).toBe('newer edit'); expect(h.host.sessionManager.configEdited).not.toHaveBeenCalled();
  });
  it.each(['native-default', undefined, 'bounded'] as const)('actual save preserves Codex %s rather than guessing from the new literal list', async toolCeiling => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setProviderById('codex').build();
    Object.assign(current, { backend: 'codex', allowedTools: [], toolCeiling });
    delete current.executePreference; delete current.builtinToolDefaultsRevision;
    const h = fixture(current, 'codex'); expect((await h.save()).ok).toBe(true);
    expect(h.sessions[0].config.toolCeiling).toBe(toolCeiling === 'bounded' ? 'bounded' : 'native-default');
    expect(h.writes[0][0].toolCeiling).toBe(h.sessions[0].config.toolCeiling);
    expect(h.sessions[0].config.executePreference).toBeUndefined();
  });
  it('does not claim a disabled command capability on a Codex route that cannot enforce it', async () => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setExecutePreference('deny').build();
    const h = fixture(current, 'codex'); const result = await h.save();
    expect(result.ok).toBe(false); expect(result.message).toContain('cannot disable native commands');
    expect(h.persist).not.toHaveBeenCalled(); expect(h.host.sessionManager.configEdited).not.toHaveBeenCalled();
  });
  it('does not publish or restart an agent after host shutdown begins during storage', async () => {
    const h = fixture(new AgentConfigBuilder().fromTemplate('contract-analyst').build());
    const before = h.sessions[0].config;
    h.persist.mockImplementationOnce(async () => { h.host.hostShutdown.started = true; });
    expect((await h.save()).ok).toBe(false); expect(h.sessions[0].config).toBe(before);
    expect(h.host.sessionManager.configEdited).not.toHaveBeenCalled(); expect(h.persist).toHaveBeenCalledTimes(2);
  });
  it('restoring reviewed permissions also stages changes and leaves every active setting unchanged after storage failure', async () => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setAllowedTools(['read']).build();
    current.modelParams = { temperature: 0.2 }; const before = structuredClone(current); const h = fixture(current);
    Object.assign(h.payload, { permissionRestoreOnly: true, allowedToolCeiling: ['read', 'write'] });
    h.persist.mockRejectedValueOnce(new Error('failed restore write'));
    await expect(h.save()).rejects.toThrow('failed restore write');
    expect(current).toEqual(before); expect(h.sessions[0].config).toBe(current); expect(h.host.sessionManager.restart).not.toHaveBeenCalled();
  });
  it('reviewed empty Codex permissions are persisted as bounded before publication, never temporarily native-default', async () => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setProviderById('codex').setAllowedTools(['read']).build();
    const h = fixture(current, 'codex'); Object.assign(h.payload, { permissionRestoreOnly: true, allowedToolCeiling: [] });
    expect((await h.save()).ok).toBe(true);
    expect(h.sessions[0].config).toMatchObject({ allowedTools: [], toolCeiling: 'bounded', codexPermissionProfile: 'approve-for-me' });
    expect(h.writes[0][0]).toEqual(h.sessions[0].config);
  });
  it('a delayed old permission-review scope cannot target a replacement team with the same agent ID', async () => {
    const h = fixture(new AgentConfigBuilder().fromTemplate('contract-analyst').build()); h.payload.permissionRestoreOnly = true;
    expect((await h.save(() => false)).ok).toBe(false); expect(h.persist).not.toHaveBeenCalled();
    expect(h.host.sessionManager.restart).not.toHaveBeenCalled();
  });
  it('rechecks the original permission-review scope after storage rather than publishing a late grant', async () => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setAllowedTools(['read']).build();
    const h = fixture(current); h.payload.permissionRestoreOnly = true; let valid = true;
    h.persist.mockImplementationOnce(async () => { valid = false; });
    expect((await h.save(() => valid)).ok).toBe(false); expect(h.sessions[0].config).toBe(current);
    expect(current.allowedTools).toEqual(['read']); expect(h.persist).toHaveBeenCalledTimes(2);
  });
});

describe('v0.9.102 G1: a Builder save carries the agent own tools through the skill change (design 3.3, Owner 2026-11-10)', () => {
  // The form harness of the describe above at its smallest: the real rendered script, the real parser, the real host.
  function page(h: ReturnType<typeof fixture>, initialSkillIds: string[], boxTools = 'read,write,search,message') {
    const current = h.sessions[0].config;
    const view: AgentBuilderViewModel = { mode: 'edit', agent: { id: current.id, name: current.name, role: current.role,
      roleKey: 'contract-analyst', roleLabel: current.role, providerId: 'roam', model: 'test-model', systemPrompt: 'Keep instructions',
      skillIds: initialSkillIds, playbooks: [], mcpServers: [], savedTools: current.allowedTools, executePreference: current.executePreference },
      roles: [{ id: 'contract-analyst', name: 'Contract Analyst', role: 'custom', systemPrompt: 'Role instructions',
        skillIds: ['documentation'], playbookIds: [], model: 'test-model', providerId: 'roam', commandToolDefaults: { deniedTools: ['delegate'] } }],
      providers: [{ id: 'roam', name: 'Test', models: [{ id: 'test-model', name: 'Test' }] }],
      capabilities: [{ id: 'documentation', name: 'Documentation', category: 'documentation', description: 'Write', requiredTools: boxTools.split(',') }],
      mcpServers: [], catalog: { agents: [], skills: [], mcp: [] }, skillLibraryUrl: '' };
    const box: any = { checked: true, dataset: { capabilityId: 'documentation', capabilityTools: boxTools } };
    box.closest = (selector: string) => selector === '[data-capability-id]' ? box : null;
    const boot = bootWebviewScript(renderAgentBuilderHtml({ cspSource: 'test:' } as never, view), {
      document: { querySelectorAll: (selector: string) => selector.includes('data-capability-id') ? [box] : [] },
    });
    for (const [id, value] of Object.entries({ role: 'contract-analyst', name: 'Renamed agent', provider: 'roam',
      model: 'test-model', systemPrompt: 'Keep instructions', toolProtocol: 'auto' })) {
      if (!boot.elements.has(id)) boot.elements.set(id, { ...boot.elements.get('role')! });
      boot.elements.get(id)!.value = value;
    }
    const save = async () => {
      for (const handler of boot.listeners.click ?? []) handler({ target: { closest: (selector: string) => selector === '#saveButton' ? {} : null } });
      const message = boot.postedMessages.find((value: any) => value.command === 'save') as { payload: unknown };
      Object.assign(h.payload, parseAgentBuilderSavePayload(message.payload, view)); return h.save();
    };
    // The person ticks (or leaves ticked) the capability box: the form recomputes its notice.
    for (const handler of boot.listeners.change ?? []) handler({ target: box });
    return { notice: () => boot.elements.get('toolWidening')!, save };
  }
  function narrowed(skills: string[]) {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').setExecutePreference('deny').build();
    current.skills = skills.map(id => SKILL_LIBRARY[id]); current.allowedTools = ['message', 'read', 'search'];
    return current;
  }

  it('a rename with the same skills keeps a narrowed agent without Write files, and the form promises nothing', async () => {
    const h = fixture(narrowed(['documentation'])); const form = page(h, ['documentation']);
    expect(form.notice().hidden).toBe(true);
    expect((await form.save()).ok).toBe(true);
    expect(h.writes[0][0].allowedTools).toEqual(['message', 'read', 'search']);
    expect(h.sessions[0].config.allowedTools).toEqual(['message', 'read', 'search']);
    expect(h.sessions[0].config.name).toBe('Renamed agent');
  });

  it('a capability ticked in this save gives its tools back, and the form names them before Save (the Open in Agent Builder recovery)', async () => {
    const h = fixture(narrowed([])); const form = page(h, []);
    expect(form.notice().hidden).toBe(false);
    expect(form.notice().textContent).toBe('Saving adds to this agent: Write files. Untick the capability that grants it to keep the agent as it is.');
    expect((await form.save()).ok).toBe(true);
    expect(h.sessions[0].config.allowedTools).toEqual(['message', 'read', 'search', 'write']);
    expect(h.sessions[0].config.executePreference).toBe('deny');
  });

  it('unticking a skill takes away only what it alone gave; a tool the agent holds on its own stays', () => {
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').build();
    delete current.roleTemplateKey; delete current.executePreference; delete current.builtinToolDefaultsRevision;
    current.skills = [SKILL_LIBRARY.testing, SKILL_LIBRARY.documentation];
    current.allowedTools = ['delegate', 'execute', 'message', 'read', 'search'];
    const edit = agentBuilderTools({ roleKey: 'custom', current, skills: [SKILL_LIBRARY.documentation], backend: 'openai-compat' });
    // execute came only from Testing; delegate came from no skill; write was never held and Documentation was not ticked now.
    expect(edit.allowedTools).toEqual(['delegate', 'message', 'read', 'search']);
  });

  it('a skill ticked now adds even a tool an older skill could have given; Off and role denials still apply last', () => {
    const current = narrowed(['documentation']);
    const edit = agentBuilderTools({ roleKey: 'contract-analyst', current,
      skills: [SKILL_LIBRARY.documentation, SKILL_LIBRARY.testing, SKILL_LIBRARY['project-management']], backend: 'openai-compat' });
    expect(edit.allowedTools).toContain('write');
    expect(edit.allowedTools).not.toContain('execute');
    expect(edit.allowedTools).not.toContain('delegate');
    expect(edit.executePreference).toBe('deny');
  });

  it('an agent with no list of its own and a native Codex agent are still derived from the ticked skills', () => {
    const unlisted = new AgentConfigBuilder().fromTemplate('contract-analyst').build(); delete unlisted.allowedTools;
    expect(builderCarriesInstanceTools(unlisted)).toBe(false);
    expect(agentBuilderTools({ roleKey: 'contract-analyst', current: unlisted, skills: [SKILL_LIBRARY.documentation], backend: 'openai-compat' })
      .allowedTools).toContain('write');
    const native = new AgentConfigBuilder().fromTemplate('contract-analyst').setProviderById('codex').build();
    Object.assign(native, { backend: 'codex', allowedTools: [], toolCeiling: 'native-default' });
    expect(builderCarriesInstanceTools(native)).toBe(false);
    expect(builderCarriesInstanceTools(narrowed(['documentation']))).toBe(true);
  });
});

describe('a typed Custom role survives Builder save, the team file, startup and a team switch (v0.9.100)', () => {
  const TEAM = '/workspace/.unode/team.json';
  const view: AgentBuilderViewModel = { mode: 'create',
    roles: [{ id: 'contract-analyst', name: 'Contract Analyst', role: 'custom', systemPrompt: 'Role instructions',
      skillIds: ['documentation'], playbookIds: [], model: 'test-model', providerId: 'roam', commandToolDefaults: { deniedTools: ['delegate'] } }],
    providers: [{ id: 'roam', name: 'Test', models: [{ id: 'test-model', name: 'Test' }] }],
    capabilities: [{ id: 'documentation', name: 'Documentation', category: 'documentation', description: 'Write', requiredTools: ['read', 'write'] }],
    mcpServers: [], catalog: { agents: [], skills: [], mcp: [] }, skillLibraryUrl: '' };
  const role = (bytes: Uint8Array | undefined, index = 0) => JSON.parse(Buffer.from(bytes!).toString('utf8')).members[index].role;
  // Other adjustments (a project file narrows tools) are not this slice's business; no notice may be about the role.
  const roleNotices = () => vi.mocked(vscode.window.showWarningMessage).mock.calls.flat().filter(text => String(text).includes('.role'));

  /** The real Builder parse, then the actual extension save handler with the real connection registry. */
  async function builderSave(customRole: string): Promise<AgentConfig[]> {
    const parsed = parseAgentBuilderSavePayload({ name: 'Integrator', roleKey: 'custom', customRole, providerId: 'roam',
      model: 'test-model', systemPrompt: 'Integrate the systems.', skillIds: ['documentation'], playbooks: [], mcpServers: [] }, view);
    expect(parsed).toBeDefined();
    const h = fixture();
    Object.assign(h.host, { effectiveConnectionRegistry: BUILTIN_CONNECTION_REGISTRY, routeForConnectionId,
      providerRefForConnectionId, connectionIdForProviderId });
    Object.assign(h.payload, parsed);
    expect(await h.save()).toMatchObject({ ok: true });
    return h.writes.at(-1)!;
  }

  it.each<[string, string]>([
    ['System Integrator', 'System Integrator'],
    ['  Image and Video Editor\u0000', 'Image and Video Editor'],
    ['图像编辑', '图像编辑'],
    // R1: the cut ends on a space; Builder must save the value the file keeps.
    [`${'a'.repeat(79)} b`, 'a'.repeat(79)],
  ])('Builder %j -> team file -> startup -> switch away and back keeps %j', async (typed, expected) => {
    disk.files.clear(); vi.mocked(vscode.window.showWarningMessage).mockClear();
    const members = await builderSave(typed);
    expect(members).toHaveLength(1); expect(members[0].role).toBe(expected);
    const values = new Map<string, unknown>();
    const persistence = new PersistenceManager({ workspaceState: {
      get: (key: string, fallback: unknown) => values.has(key) ? values.get(key) : fallback,
      keys: () => [...values.keys()], update: async (key: string, value: unknown) => { values.set(key, value); },
    }, globalStorageUri: { fsPath: '/global' } } as never, undefined, () => '/workspace');
    await persistence.saveAgents(members);
    await persistence.saveTeamConfig({ version: '1.0', members, mcpServers: [], workflows: [] });
    const written = disk.files.get(TEAM);
    expect(role(written)).toBe(expected);

    // Startup reads it as the team (not ignored), with nothing to adjust, and does not write it back.
    const writesBeforeRead = vi.mocked(vscode.workspace.fs.writeFile).mock.calls.length;
    const startup = await persistence.loadTeamConfigForStartup();
    expect(startup).toMatchObject({ kind: 'ready', document: { members: [expect.objectContaining({ id: members[0].id, role: expected })] } });
    expect(startup.kind === 'ready' ? startup.document?.validationWarnings?.filter(warning => warning.includes('.role')) : undefined).toEqual([]);
    expect(roleNotices()).toEqual([]);
    expect(vi.mocked(vscode.workspace.fs.writeFile).mock.calls.length).toBe(writesBeforeRead);
    expect(disk.files.get(TEAM)).toBe(written);

    // Save it to the project library, switch to another team, and load it back.
    await persistence.saveTeamToLibrary({ scope: 'workspace', slug: 'integrators' }, 'Integrators', members);
    let live: AgentConfig[] = members;
    const ops = { currentMembers: () => live, assertCurrent: () => {}, snapshotOutgoing: vi.fn(async () => true),
      stopAndPrepare: async () => {}, publish: async (next: AgentConfig[]) => { live = next; } };
    const other: TeamFileDocument = { version: '1.0', mcpServers: [], workflows: [],
      members: [new AgentConfigBuilder().fromTemplate('contract-analyst').setId('other').build()] };
    await expect(persistence.replaceSavedTeam(other, ops)).resolves.toBe(true);
    expect(live.map(member => member.id)).toEqual(['other']);
    expect(ops.snapshotOutgoing).toHaveBeenCalledWith(expect.objectContaining({ members: [expect.objectContaining({ role: expected })] }));
    const saved = await persistence.loadSavedTeamWithTrust({ scope: 'workspace', slug: 'integrators' });
    expect(saved?.document.members[0].role).toBe(expected);
    await expect(persistence.replaceSavedTeam(saved!.document, ops)).resolves.toBe(true);
    expect(live).toEqual([expect.objectContaining({ id: members[0].id, role: expected })]);
    expect(role(disk.files.get(TEAM))).toBe(expected);
    // The file the switch wrote is itself a valid outgoing team.
    await expect(persistence.replaceSavedTeam(other, ops)).resolves.toBe(true);
    expect(roleNotices()).toEqual([]);
  });

  it('Builder refuses a Custom role that is only control characters or spaces, in the parse and the reason', () => {
    for (const customRole of ['\u0000\t', '   ']) {
      const raw = { name: 'Integrator', roleKey: 'custom', customRole, providerId: 'roam', model: 'test-model',
        systemPrompt: 'Integrate.', skillIds: [], playbooks: [], mcpServers: [] };
      expect(parseAgentBuilderSavePayload(raw, view)).toBeUndefined();
      expect(describeAgentBuilderSaveProblem(raw, view)).toContain('Custom role name');
    }
  });
});

describe('v0.9.104 B1: an unchanged Builder save keeps every playbook of its role, and reopening shows each one selected', () => {
  const shippedCatalog = parseSkillCatalog(JSON.parse(readFileSync('marketplace/skills.json', 'utf8')));
  const analystPlaybooks = ROLE_TEMPLATES['contract-analyst'].playbooks ?? [];
  function viewFor(playbooks: string[], skills = shippedCatalog, id = 'analyst'): AgentBuilderViewModel {
    return { mode: 'edit', agent: { id, name: 'Contract Analyst', role: 'custom', roleKey: 'contract-analyst', roleLabel: 'custom',
      providerId: 'roam', model: 'test-model', systemPrompt: 'Keep instructions', skillIds: ['documentation'], playbooks, mcpServers: [] },
      roles: [{ id: 'contract-analyst', name: 'Contract Analyst', role: 'custom', systemPrompt: 'Role instructions',
        skillIds: ['documentation'], playbookIds: analystPlaybooks, model: 'test-model', providerId: 'roam' }],
      providers: [{ id: 'roam', name: 'Test', models: [{ id: 'test-model', name: 'Test' }] }],
      capabilities: [{ id: 'documentation', name: 'Documentation', category: 'documentation', description: 'Write', requiredTools: ['read', 'write'] }],
      mcpServers: [], catalog: { agents: [], skills, mcp: [] }, skillLibraryUrl: '' } as AgentBuilderViewModel;
  }
  /** The person opens the agent in the real Builder page and presses Save without changing anything. */
  function unchangedSave(view: AgentBuilderViewModel): unknown {
    const boot = bootWebviewScript(renderAgentBuilderHtml({ cspSource: 'test:' } as never, view), { document: { querySelectorAll: () => [] } });
    for (const [id, value] of Object.entries({ role: 'contract-analyst', name: 'Contract Analyst', provider: 'roam', model: 'test-model',
      systemPrompt: 'Keep instructions', toolProtocol: 'auto' })) {
      if (!boot.elements.has(id)) boot.elements.set(id, { ...boot.elements.get('role')! });
      boot.elements.get(id)!.value = value;
    }
    for (const handler of boot.listeners.click ?? []) handler({ target: { closest: (selector: string) => selector === '#saveButton' ? {} : null } });
    return (boot.postedMessages.find((value: any) => value.command === 'save') as { payload: unknown }).payload;
  }
  const shownSelected = (view: AgentBuilderViewModel) => {
    const html = renderAgentBuilderHtml({ cspSource: 'test:' } as never, view);
    return [...html.matchAll(/data-playbook-id="([^"]+)" checked/g)].map((match) => match[1]);
  };

  it('Contract Analyst through the page, the parser and the host save: all 7 playbooks stay bound and show as selected when reopened', async () => {
    expect(analystPlaybooks).toHaveLength(7);
    const current = new AgentConfigBuilder().fromTemplate('contract-analyst').build();
    current.playbooks = [...analystPlaybooks];
    const h = fixture(current);
    const view = viewFor(current.playbooks, shippedCatalog, current.id);
    expect(shownSelected(view).sort()).toEqual([...analystPlaybooks].sort());
    const parsed = parseAgentBuilderSavePayload(unchangedSave(view), view);
    expect(parsed?.playbooks).toEqual(analystPlaybooks);
    Object.assign(h.payload, parsed);
    expect((await h.save()).ok).toBe(true);
    const saved = h.sessions[0].config.playbooks ?? [];
    expect(saved).toEqual(analystPlaybooks);
    // Reopened from what was stored: every playbook is selected again, and a second unchanged save keeps them.
    const reopened = viewFor(saved, shippedCatalog, current.id);
    expect(shownSelected(reopened).sort()).toEqual([...analystPlaybooks].sort());
    expect(parseAgentBuilderSavePayload(unchangedSave(reopened), reopened)?.playbooks).toEqual(analystPlaybooks);
  });

  it('a save keeps every playbook the host handed the form even when the catalog lacks it; an id the host never offered is refused', () => {
    const view = viewFor(['legacy-agent-playbook'], []);
    const raw = (playbooks: string[]) => ({ name: 'Contract Analyst', roleKey: 'contract-analyst', providerId: 'roam', model: 'test-model',
      systemPrompt: 'Keep instructions', skillIds: ['documentation'], playbooks, mcpServers: [] });
    // The agent's own and the role template's playbooks survive with an empty catalog.
    expect(parseAgentBuilderSavePayload(raw(['legacy-agent-playbook', ...analystPlaybooks]), view)?.playbooks)
      .toEqual(['legacy-agent-playbook', ...analystPlaybooks]);
    expect(parseAgentBuilderSavePayload(raw(['invented-by-the-page', 'legacy-agent-playbook']), view)?.playbooks).toEqual(['legacy-agent-playbook']);
    // A new agent has no stored playbooks of its own to keep.
    expect(parseAgentBuilderSavePayload(raw(['legacy-agent-playbook']), { ...view, mode: 'new' })?.playbooks).toEqual([]);
  });

  it('every playbook of every built-in role template is in the catalog, so the Builder can show and offer it', () => {
    const catalogued = new Set(shippedCatalog.map((skill) => skill.id));
    const missing = Object.entries(ROLE_TEMPLATES).flatMap(([key, template]) => (template.playbooks ?? [])
      .filter((id) => !catalogued.has(id)).map((id) => `${key}: ${id}`));
    expect(missing).toEqual([]);
  });
});
