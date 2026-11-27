import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
const ui = vi.hoisted(() => ({ choice: undefined as string | undefined, panels: [] as any[] }));
vi.mock('vscode', () => ({
  ViewColumn: { One: 1 }, QuickPickItemKind: { Separator: -1 },
  commands: { executeCommand: vi.fn(async () => undefined) },
  workspace: { getConfiguration: () => ({ get: () => '', update: vi.fn() }), workspaceFolders: [] },
  window: {
    showQuickPick: vi.fn(async (items: any[]) => items.find(item => item.roleKey === 'senior-dev') ?? items[0]),
    showInputBox: vi.fn(async () => 'Riley'), showInformationMessage: vi.fn(async () => ui.choice), showWarningMessage: vi.fn(async () => undefined),
    createWebviewPanel: vi.fn(() => {
      const panel: any = { title: '', visible: true, dispose: vi.fn(), reveal: vi.fn(), onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }),
        webview: { cspSource: 'test:', html: '', postMessage: vi.fn(async () => true), onDidReceiveMessage: (handler: any) => { panel.receive = handler; return { dispose() {} }; } } };
      ui.panels.push(panel); return panel;
    }),
  },
}));
import * as vscode from 'vscode';
import { showAddAgentDialog, createSoloAgent } from '../../dialogs';
import { AgentBuilderPanel, renderAgentBuilderHtml, type AgentBuilderViewModel } from '../AgentBuilderPanel';
import { MarketplacePanel } from '../MarketplacePanel';
import { showMemberAddedNotice } from '../MemberInstructionsAction';
import { bootWebviewScript } from './support/webviewBoot';
import { temporaryFolder, removeTemporaryFolders } from '../../backend/__tests__/pathSafetyFixtures';
import { TeamTools } from '../../backend/TeamTools';
import { MessageBus } from '../../bus/MessageBus';

afterEach(async () => { ui.choice = undefined; ui.panels.splice(0); AgentBuilderPanel.current = undefined; vi.clearAllMocks(); await removeTemporaryFolders(); });
const flush = async () => { for (let round = 0; round < 8; round++) await Promise.resolve(); };
function formToken(panel: { webview: { html: string } }): string {
  const token = panel.webview.html.match(/let formToken = "([^"]+)"/)?.[1];
  expect(token).toBeTruthy();
  return token!;
}
function dialogDeps(hasKey = true) {
  const created: any[] = []; const deps: any = { sessionManager: { getAll: () => created.map(config => ({ config })), create: (config: any) => created.push(config) },
    output: { info() {}, warn() {} }, secrets: { has: async () => hasKey, get: async () => undefined, promptAndStore: vi.fn() },
    defaultProvider: () => 'anthropic', defaultBackendKind: () => 'claude', chooseConnection: async (items: any[]) => items.find(item => item.providerKey === 'anthropic'),
    commandPolicy: { approvalMode: 'none', reload() {} }, reloadCommandPolicy() {}, modelCatalog: { list: async () => [] }, refreshPrices() {} };
  return { deps, created };
}
function view(id?: string): AgentBuilderViewModel {
  return { mode: id ? 'edit' : 'new', ...(id ? { agent: { id, name: 'Riley', roleKey: 'writer', providerId: 'provider', model: 'fake', systemPrompt: 'Only Riley instructions', skillIds: [], playbooks: [], mcpServers: [] } } : {}),
    roles: [{ id: 'writer', name: 'Writer', role: 'writer', systemPrompt: 'Only Riley instructions', skillIds: [], playbookIds: [], providerId: 'provider', model: 'fake' }],
    providers: [{ id: 'provider', name: 'Provider', models: [{ id: 'fake', name: 'Fake' }] }], capabilities: [], mcpServers: [], catalog: { agents: [], mcp: [], skills: [] }, skillLibraryUrl: 'https://example.invalid' } as AgentBuilderViewModel;
}
it.each([true, false])('single Add Agent result opens the right instructions, existing key=%s', async hasKey => {
  ui.choice = "Edit Riley's instructions"; const h = dialogDeps(hasKey); const config = await showAddAgentDialog(h.deps); await flush();
  expect(config).toBeDefined(); expect(h.created).toHaveLength(1); expect(vscode.commands.executeCommand).toHaveBeenCalledWith('unode.openAgentBuilder', { agentId: config!.id, focus: 'instructions' });
  const result = vi.mocked(vscode.window.showInformationMessage).mock.calls.find(call => String(call[0]).includes('added'))!;
  expect(result).toContain("Edit Riley's instructions"); expect(result.slice(1).every(item => typeof item === 'string')).toBe(true); expect(h.deps.secrets.promptAndStore).not.toHaveBeenCalled();
});
it('ignoring the single-add action leaves actual team-rules bytes and the added default config unchanged', async () => {
  const root = await temporaryFolder('unode-member-instructions-'); await fs.mkdir(join(root, '.unode')); const rules = join(root, '.unode', 'rules.md'); const bytes = Buffer.from('# Team rules\nKeep the generated roster and user guidance.\n'); await fs.writeFile(rules, bytes);
  const h = dialogDeps(); const config = await showAddAgentDialog(h.deps); const afterAdd = JSON.stringify(config); await flush();
  expect(JSON.stringify(config)).toBe(afterAdd); expect(await fs.readFile(rules)).toEqual(bytes); expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
});
it('does not add a notice for the Solo route', async () => {
  const h = dialogDeps(); const config = await createSoloAgent(h.deps); await flush(); expect(config).toBeDefined();
  expect(vi.mocked(vscode.window.showInformationMessage).mock.calls.every(call => !call.some(item => typeof item === 'string' && item.includes("'s instructions")))).toBe(true);
  expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
});
it('keeps the builder new-member result in its own panel and opens the actual added id only on the action', async () => {
  const save = vi.fn(async () => ({ ok: true, message: 'Added Riley to your team.', addedMember: { agentId: 'new-id', name: 'Riley' } }));
  const deps = { getViewModel: (id?: string) => view(id), listModels: async () => [], save, pickIcon: async () => undefined, pickFolderAccessFolder: async () => undefined,
    resolveFolderAccessIssues: async () => [], openSkillLibrary: async () => {}, addMcpServer: async () => {} };
  AgentBuilderPanel.createOrShow({} as never, deps); await flush(); const panel = ui.panels[0];
  await panel.receive({ command: 'save', formToken: formToken(panel), payload: { name: 'Riley', roleKey: 'writer', providerId: 'provider', model: 'fake', systemPrompt: 'Only Riley instructions', skillIds: [], playbooks: [], mcpServers: [] } });
  expect(save).toHaveBeenCalledOnce(); expect(panel.webview.html).toContain('memberAddedResult'); expect(panel.webview.html).toContain('Edit Riley'); expect(panel.webview.html).toContain('Edit Agent');
  expect(panel.dispose).not.toHaveBeenCalled(); expect(vscode.window.showInformationMessage).not.toHaveBeenCalled(); expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  await panel.receive({ command: 'editAddedMemberInstructions', payload: { agentId: 'forged' } });
  expect(vscode.commands.executeCommand).toHaveBeenCalledWith('unode.openAgentBuilder', { agentId: 'new-id', focus: 'instructions' });
});
it('an existing-member builder save offers no added-member action, including a forged action message', async () => {
  AgentBuilderPanel.createOrShow({} as never, { getViewModel: (id?: string) => view(id), listModels: async () => [], save: async () => ({ ok: true, message: 'Updated Riley.' }),
    pickIcon: async () => undefined, pickFolderAccessFolder: async () => undefined, resolveFolderAccessIssues: async () => [], openSkillLibrary: async () => {}, addMcpServer: async () => {} }, 'existing-id');
  await flush(); const panel = ui.panels[0];
  await panel.receive({ command: 'save', formToken: formToken(panel), payload: { id: 'existing-id', name: 'Riley', roleKey: 'writer', providerId: 'provider', model: 'fake', systemPrompt: 'Only Riley instructions', skillIds: [], playbooks: [], mcpServers: [] } });
  expect(panel.webview.html.includes('id="memberAddedResult"')).toBe(false);
  expect(panel.dispose, JSON.stringify(vi.mocked(vscode.window.showWarningMessage).mock.calls)).toHaveBeenCalledOnce();
  await panel.receive({ command: 'editAddedMemberInstructions', payload: { agentId: 'forged' } }); expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
});
it('the added-member action preserves unsaved form values when the correct member is already open', async () => {
  const getViewModel = vi.fn((id?: string) => view(id));
  const deps = { getViewModel, listModels: async () => [], save: async () => ({ ok: true, message: 'Added Riley.', addedMember: { agentId: 'new-id', name: 'Riley' } }),
    pickIcon: async () => undefined, pickFolderAccessFolder: async () => undefined, resolveFolderAccessIssues: async () => [], openSkillLibrary: async () => {}, addMcpServer: async () => {} };
  AgentBuilderPanel.createOrShow({} as never, deps); await flush(); const panel = ui.panels[0];
  await panel.receive({ command: 'save', formToken: formToken(panel), payload: { name: 'Riley', roleKey: 'writer', providerId: 'provider', model: 'fake', systemPrompt: 'Only Riley instructions', skillIds: [], playbooks: [], mcpServers: [] } });
  const html = panel.webview.html; const reads = getViewModel.mock.calls.length; const boot = bootWebviewScript(html, { focusModel: {} });
  expect(html).toContain('id="name"'); expect(html).toContain('id="systemPrompt"');
  // These rendered controls are read on Save rather than boot, so supply their unsaved DOM values to the lazy stub.
  const name = { value: 'Unsaved name' }; const instructions = { value: 'Unsaved personal instructions', focus: vi.fn() };
  boot.elements.set('name', name as never); boot.elements.set('systemPrompt', instructions as never);
  vi.mocked(vscode.commands.executeCommand).mockImplementationOnce(async (_command, target: any) => { AgentBuilderPanel.createOrShow({} as never, deps, target.agentId, target.focus); });
  await panel.receive({ command: 'editAddedMemberInstructions' }); await flush();
  expect(panel.webview.html).toBe(html); expect(getViewModel).toHaveBeenCalledTimes(reads + 1);
  const message = panel.webview.postMessage.mock.calls.at(-1)[0]; expect(message).toEqual({ command: 'focusInstructions' });
  for (const listener of boot.listeners.message) listener({ data: message });
  expect(name.value).toBe('Unsaved name'); expect(instructions.value).toBe('Unsaved personal instructions'); expect(instructions.focus).toHaveBeenCalledOnce();
});
it('reopening dirty instructions refreshes revoked grants and saves the typed fields from the actual form', async () => {
  let grants = ['fixture'];
  const save = vi.fn(async () => ({ ok: true, message: 'Updated.' }));
  const deps = {
    getViewModel: (id?: string) => {
      const current = view(id);
      return { ...current, agent: { ...current.agent!, mcpServers: grants }, mcpServers: ['fixture', 'other'].map(id =>
        ({ id, name: id, transport: 'stdio', connected: false, requiresApproval: false })) };
    },
    listModels: async () => [], save, pickIcon: async () => undefined, pickFolderAccessFolder: async () => undefined,
    resolveFolderAccessIssues: async () => [], openSkillLibrary: async () => {}, addMcpServer: async () => {},
  };
  AgentBuilderPanel.createOrShow({} as never, deps, 'member'); await flush();
  const panel = ui.panels[0];
  const staleToken = formToken(panel);
  const html = panel.webview.html;
  let patched = false;
  let boot: ReturnType<typeof bootWebviewScript>;
  boot = bootWebviewScript(html, { focusModel: {}, document: {
    querySelectorAll: selector => {
      if (selector !== '[data-mcp-id]:checked') return [];
      if (!patched) return ['fixture', 'other'].map(mcpId => ({ checked: true, dataset: { mcpId } }));
      return (boot.elements.get('mcpChecks') as any).children.flatMap((label: any) => label.children.slice(0, 1))
        .filter((box: any) => box.checked);
    },
  } });
  const inputs = { name: 'Changed name', role: 'writer', provider: 'provider', model: 'fake', systemPrompt: 'New unsaved instructions' };
  for (const [id, value] of Object.entries(inputs)) {
    const element = boot.elements.get(id);
    if (element) element.value = value;
    else boot.elements.set(id, { value, focus: vi.fn() } as never);
  }
  await panel.receive({ command: 'formDirty' });
  grants = [];
  AgentBuilderPanel.createOrShow({} as never, deps, 'member', 'instructions'); await flush();
  expect(ui.panels).toHaveLength(1);
  expect(panel.webview.html).toBe(html);
  const refresh = panel.webview.postMessage.mock.calls.at(-1)[0];
  expect(refresh).toMatchObject({ command: 'mcpServers', grantRefresh: { current: [], previousToken: staleToken } });
  for (const listener of boot.listeners.message) listener({ data: refresh });
  patched = true;
  expect(boot.elements.get('mcpGrantRefreshNotice')).toMatchObject({ hidden: false, textContent: expect.stringContaining('Integration grants changed') });
  expect(boot.elements.get('systemPrompt')?.value).toBe(inputs.systemPrompt);
  expect(boot.elements.get('name')?.value).toBe(inputs.name);
  for (const listener of boot.listeners.click) listener({ target: { closest: (selector: string) => selector === '#saveButton' ? {} : null } });
  const submitted = boot.postedMessages.find((message: any) => message.command === 'save') as { formToken: string; payload: unknown };
  expect(submitted.formToken).not.toBe(staleToken);
  await panel.receive({ ...submitted, formToken: staleToken });
  expect(save).not.toHaveBeenCalled();
  await panel.receive(submitted);
  expect(save).toHaveBeenCalledWith(expect.objectContaining({
    id: 'member', name: inputs.name, systemPrompt: inputs.systemPrompt, mcpGrantBaseline: [], mcpServers: ['other'],
  }));
});
it('reopening clean instructions refreshes the stale form and clears the added-member result', async () => {
  let grants: string[] = [];
  const deps = {
    getViewModel: (id?: string) => {
      const current = view(id);
      return current.agent ? { ...current, agent: { ...current.agent, mcpServers: grants } } : current;
    },
    listModels: async () => [], save: async () => ({ ok: true, message: 'Added.', addedMember: { agentId: 'new-id', name: 'Riley' } }),
    pickIcon: async () => undefined, pickFolderAccessFolder: async () => undefined, resolveFolderAccessIssues: async () => [],
    openSkillLibrary: async () => {}, addMcpServer: async () => {},
  };
  AgentBuilderPanel.createOrShow({} as never, deps); await flush();
  const panel = ui.panels[0];
  await panel.receive({ command: 'save', formToken: formToken(panel), payload: {
    name: 'Riley', roleKey: 'writer', providerId: 'provider', model: 'fake', systemPrompt: 'Initial instructions',
  } });
  expect(panel.webview.html).toContain('id="memberAddedResult"');
  const staleToken = formToken(panel);
  grants = ['fixture'];
  AgentBuilderPanel.createOrShow({} as never, deps, 'new-id', 'instructions'); await flush();
  expect(formToken(panel)).not.toBe(staleToken);
  expect(panel.webview.html).not.toContain('id="memberAddedResult"');
});
it('an instructions request for a different member still loads that member and focuses its own form', async () => {
  const getViewModel = vi.fn((id?: string) => ({ ...view(id), agent: { ...view(id).agent!, name: id!, systemPrompt: `Only ${id}` } }));
  const deps = { getViewModel, listModels: async () => [], save: async () => ({ ok: true, message: 'Updated.' }), pickIcon: async () => undefined,
    pickFolderAccessFolder: async () => undefined, resolveFolderAccessIssues: async () => [], openSkillLibrary: async () => {}, addMcpServer: async () => {} };
  AgentBuilderPanel.createOrShow({} as never, deps, 'first-id'); await flush(); const panel = ui.panels[0];
  AgentBuilderPanel.createOrShow({} as never, deps, 'second-id', 'instructions'); await flush();
  expect(getViewModel).toHaveBeenLastCalledWith('second-id'); expect(panel.webview.html).toContain('Only second-id'); expect(panel.webview.html).not.toContain('Only first-id');
  const boot = bootWebviewScript(panel.webview.html, { focusModel: {} }); expect(boot.activeElement()).toBe(boot.elements.get('systemPrompt'));
});
it('marketplace single-member result has one nonmodal action with the correct id', async () => {
  ui.choice = "Edit Riley's instructions";
  const panel: any = Object.create(MarketplacePanel.prototype); panel.catalog = { agents: [{ id: 'writer', name: 'Writer' }], mcp: [], skills: [] };
  panel.panel = { webview: { postMessage: vi.fn() } }; panel.getViewState = () => ({ agents: [], integrations: {} });
  panel.onInstall = async () => ({ ok: true, message: 'Added Riley.', addedMember: { agentId: 'market-id', name: 'Riley' } });
  panel.onMessage({ command: 'install', action: { kind: 'agent', entryId: 'writer', target: 'current-team' } }); await flush();
  expect(vscode.window.showInformationMessage).toHaveBeenCalledOnce(); expect(vscode.commands.executeCommand).toHaveBeenCalledWith('unode.openAgentBuilder', { agentId: 'market-id', focus: 'instructions' });
});
it.each(['instructions', 'unknown'])('actual builder focus request %s focuses only the admitted instructions target', focus => {
  const html = renderAgentBuilderHtml({ cspSource: 'test:' } as never, { ...view('member-id'), focus: focus as any }); const boot = bootWebviewScript(html, { focusModel: {} });
  if (focus === 'instructions') expect(boot.activeElement()).toBe(boot.elements.get('systemPrompt'));
  else expect(boot.activeElement()).not.toBe(boot.elements.get('systemPrompt'));
});
it('an unavailable optional notice does not fail an already-added member', () => {
  vi.mocked(vscode.window.showInformationMessage).mockImplementationOnce(() => { throw Error('UI unavailable'); });
  expect(() => showMemberAddedNotice('Added Riley.', { agentId: 'id', name: 'Riley' })).not.toThrow();
});
it('the agent-tool lane cannot manufacture a human member-added notice or instructions action', async () => {
  const tools = new TeamTools('pm', { list: () => [], resolve: () => undefined } as never, new MessageBus());
  expect(await tools.run('add_agent', { name: 'Model-created' })).toContain('unknown team tool');
  expect(vscode.window.showInformationMessage).not.toHaveBeenCalled(); expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
});
