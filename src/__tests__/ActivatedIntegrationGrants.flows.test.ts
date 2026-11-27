import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as vscode from 'vscode';

const host = await vi.hoisted(async () => (await import('./support/activatedVscode')).createActivatedHost());
vi.mock('vscode', async () => (await import('./support/activatedVscode')).activatedVscodeModule(host));
vi.mock('../routes/CapabilityGuard', async importOriginal => {
  const original = await importOriginal<typeof import('../routes/CapabilityGuard')>();
  return {
    ...original,
    connectionProfileForAgent: (...args: Parameters<typeof original.connectionProfileForAgent>) => {
      const profile = original.connectionProfileForAgent(...args);
      return profile && (args[0] as { id?: string }).id === 'unsupported'
        ? { ...profile, capabilities: { ...profile.capabilities, mcp: false } } : profile;
    },
  };
});

import { PersistenceManager } from '../state/PersistenceManager';
import { RootScopedWorkspaceState } from '../state/RootScopedWorkspaceState';
import { bootWebviewScript } from '../views/__tests__/support/webviewBoot';
import { agent, context, flush, installActivatedExtension, pumpWhile, replies, requests, scripts, workspace } from './support/activatedHarness';
import { recordPanels } from './support/setupGuidePage';
import { approvalKey } from '../mcp/McpApproval';
import { AgentConfigBuilder } from '../roles/RoleConfig';
import type { AgentConfig, MCPServerConfig } from '../types';
import type { MCPHub, McpServerGrant } from '../mcp/MCPHub';

const panels = recordPanels(host);
const storage = () => new PersistenceManager(context as never, undefined, () => workspace, undefined, undefined,
  new RootScopedWorkspaceState(context.workspaceState as never, workspace));

const support: MCPServerConfig = {
  id: 'support', name: 'Support', transport: 'stdio', command: process.execPath,
  args: [path.join(process.cwd(), 'src', 'mcp', '__tests__', 'fixtures', 'stdio-mcp-server.cjs')],
};
const first = { ...agent('senior-dev', 'first', 'Researcher', 'first-model'), mcpServers: ['support'] };
const second: AgentConfig = {
  ...agent('senior-dev', 'second', 'Researcher', 'second-model'), mcpServers: ['support'],
  skills: [{ id: 'fixture-skill', name: 'Fixture research', description: 'Read fixture codes', category: 'external', implementation: {
    type: 'mcp-server', serverId: 'fixture', toolFilter: 'allowlist', toolList: ['lookup_code'],
  } }],
};
beforeAll(async () => {
  await storage().saveHostMcpServers([
    { id: 'fixture', name: 'Fixture', transport: 'stdio', command: process.execPath },
    { id: 'time', name: 'Custom Time', transport: 'stdio', command: process.execPath, args: ['custom folder'], timeoutMs: 45_000 },
    support,
  ]);
  await storage().saveApprovedMcpServers([approvalKey(support, workspace)]);
});

it('catalog Reconfigure opens the edited configuration and next member start mounts it', async () => {
  const inputs: Array<{ prompt: string; value: string | undefined }> = [];
  const handleInput = vi.fn(async (input: { prompt: string; value?: string }) => {
    inputs.push({ prompt: input.prompt, value: input.value });
    return input.prompt === 'Display name' ? 'My Time' : input.prompt === 'Command arguments as a JSON array'
      ? JSON.stringify([support.args![0], 'new folder with spaces', '']) : input.value;
  });
  host.overrides['vscode.window.showInputBox'] = handleInput;
  host.overrides['vscode.window.showQuickPick'] = async (options: unknown[]) => options[0];
  host.commands.get('unode.openMarketplace')?.('mcp');
  const panel = panels.filter(entry => entry.viewType === 'unodeMarketplace').at(-1)!;
  await pumpWhile(() => !panel.webview.html.includes('Reconfigure'), flush);
  const approvals = storage().loadApprovedMcpServers();
  panel.receive?.({ command: 'install', action: { kind: 'mcp', entryId: 'time', scope: 'current-team' } });
  await pumpWhile(() => !host.infos.some(info => info.includes('Saved "My Time"')), flush);
  expect(inputs.map(input => input.value)).toEqual(['Custom Time', process.execPath, '["custom folder"]', '']);
  expect(storage().loadHostMcpServers().find(row => row.id === 'time')).toMatchObject({
    name: 'My Time', command: process.execPath, args: [support.args![0], 'new folder with spaces', ''], timeoutMs: 45_000,
  });
  expect(storage().loadApprovedMcpServers()).toEqual(approvals);
  let picker!: Picker;
  let save!: () => void;
  host.overrides['vscode.window.createQuickPick'] = () => {
    const control = {
      items: [], selectedItems: [], canSelectMany: false,
      onDidAccept: (callback: () => void) => { save = callback; },
      onDidHide: () => {}, show: () => {}, hide: () => {}, dispose: () => {},
    };
    picker = control;
    return control;
  };
  panel.receive?.({ command: 'grantIntegration', serverId: 'time' });
  picker.selectedItems = picker.items.filter(item => item.agentId === second.id);
  save();
  await pumpWhile(() => !host.infos.some(info => info.includes('Saved direct grants for "My Time"')), flush);
  const showWarning = host.overrides['vscode.window.showWarningMessage'];
  const approve = vi.fn(async (message: string) => message.includes('MCP server "My Time"') ? 'Approve & Mount' : undefined);
  host.overrides['vscode.window.showWarningMessage'] = approve;
  try {
    scripts.set('second-model', () => ({ text: 'Time tools ready.' }));
    await screen.select(second.id);
    await screen.send('Check that time tools are ready.');
    await pumpWhile(() => !replies(second.id).includes('Time tools ready.'), screen.pump);
    expect(approve.mock.calls.some(([message]) => message.includes('MCP server "My Time"'))).toBe(true);
    expect(requests.filter(request => request.model === 'second-model').flatMap(request => request.tools ?? []))
      .toContainEqual(expect.objectContaining({ function: expect.objectContaining({ name: 'time__lookup_code' }) }));
    const edited = storage().loadHostMcpServers().find(row => row.id === 'time')!;
    expect(storage().loadApprovedMcpServers()).toContain(approvalKey(edited, workspace));
  } finally {
    host.overrides['vscode.window.showWarningMessage'] = showWarning;
  }
  panel.disposeListener?.();
});

async function builderForm(mcpServers: string[]) {
  await host.commands.get('unode.openAgentBuilder')?.(first.id);
  const panel = panels.filter(entry => entry.viewType === 'unodeAgentBuilder').at(-1)!;
  await pumpWhile(() => !panel.webview.html.includes('let formToken ='), flush);
  const formToken = panel.webview.html.match(/let formToken = "([^"]+)"/)?.[1];
  expect(formToken).toBeTruthy();
  const submit = () => panel.receive?.({ command: 'save', formToken, payload: {
    id: first.id, name: first.name, roleKey: 'senior-dev', providerId: 'openai', model: first.model,
    systemPrompt: 'Revised researcher instructions.', skillIds: [], playbooks: [], mcpServers,
  } });
  return { panel, submit };
}

async function integrationCard() {
  await host.commands.get('unode.openMarketplace')?.('mcp');
  const panel = panels.filter(entry => entry.viewType === 'unodeMarketplace').at(-1)!;
  await pumpWhile(() => !panel.webview.html.includes('data-command="grantIntegration"'), flush);
  return panel;
}

async function acceptGrant(panel: Awaited<ReturnType<typeof integrationCard>>, serverId: string, ids: string[]) {
  let picker!: Picker;
  let accept!: () => void;
  let hide!: () => void;
  host.overrides['vscode.window.createQuickPick'] = () => {
    picker = {
      items: [], selectedItems: [], canSelectMany: false,
      onDidAccept: (callback: () => void) => { accept = callback; },
      onDidHide: (callback: () => void) => { hide = callback; },
      show: () => {}, hide: () => hide(), dispose: () => {},
    } as Picker;
    return picker;
  };
  const notices = host.infos.length;
  const warnings = host.warnings.length;
  panel.receive?.({ command: 'grantIntegration', serverId });
  expect(picker.items.filter(item => ids.includes(item.agentId ?? ''))).toHaveLength(ids.length);
  picker.selectedItems = picker.items.filter(item => ids.includes(item.agentId ?? ''));
  accept();
  await pumpWhile(() => !host.infos.slice(notices).some(message => message.includes('Saved direct grants'))
    && host.warnings.length === warnings, flush);
  expect(host.warnings.slice(warnings)).toEqual([]);
  await flush();
}

let screen: Parameters<Parameters<typeof installActivatedExtension>[1]>[0]['screen'];
installActivatedExtension(host, ready => { screen = ready.screen; }, {
  agents: [first, second, agent('senior-dev', 'unsupported', 'Unsupported', 'unused-model')],
});
afterAll(async () => { await (await import('../extension')).deactivate(); });

type Item = { agentId?: string; label: string; detail?: string; description?: string };
interface Picker {
  title?: string;
  items: Item[];
  selectedItems: Item[];
  canSelectMany: boolean;
}

it('picker uses stable IDs, blocks unsupported grants and preserves filtered skills', async () => {
  let picker: Picker | undefined;
  let accept: () => void;
  let cancel: () => void;
  let opened = 0;
  host.overrides['vscode.window.createQuickPick'] = () => {
    picker = {
      items: [], selectedItems: [], canSelectMany: false,
      ...{
        onDidAccept: (callback: () => void) => { accept = callback; },
        onDidHide: (callback: () => void) => { cancel = callback; },
        show: () => { opened++; },
        hide: () => cancel(),
        dispose: () => {},
      },
    };
    return picker;
  };
  host.commands.get('unode.openMarketplace')?.('mcp');
  const panel = panels.find(entry => entry.viewType === 'unodeMarketplace')!;
  await pumpWhile(() => !panel.webview.html.includes('data-command="grantIntegration"'), flush);
  const page = bootWebviewScript(panel.webview.html);
  const click = () => {
    const button = { dataset: { command: 'grantIntegration', serverId: 'fixture' } };
    const start = page.postedMessages.length;
    for (const listener of page.listeners.click) {
      listener({ target: { closest: (selector: string) => selector === 'button[data-command]' ? button : null } });
    }
    for (const message of page.postedMessages.slice(start)) panel.receive?.(message);
  };
  const roster = () => storage().loadAgents().map(row => row.mcpServers?.includes('fixture') ?? false);
  panel.receive?.({ command: 'grantIntegration', serverId: 'fixture', agentIds: ['second'] });
  expect(opened).toBe(0);
  click();
  expect(picker?.canSelectMany).toBe(true);
  expect(picker?.items.map(item => item.label)).toEqual(['Researcher · first', 'Researcher · second']);
  expect(picker?.title).toContain('MCP unavailable: Unsupported');
  expect(picker?.items.slice(0, 2).map(item => item.detail)).toEqual(['Available after the next start', 'Available after the next start']);
  expect(picker?.items[1].description).toContain('Skill grant (lookup_code)');
  picker!.selectedItems = [{ agentId: 'unsupported', label: 'Forged selection' }];
  accept!();
  await pumpWhile(() => !host.warnings.some(info => info.includes('connection no longer supports MCP')), flush);
  expect(roster()).toEqual([false, false, false]);

  click();
  picker!.selectedItems = [picker!.items[1]];
  accept!();
  await pumpWhile(() => !host.infos.some(info => info.includes('Saved direct grants for "Fixture"')), flush);
  expect(roster()).toEqual([false, true, false]);

  click();
  expect(picker?.selectedItems.map(item => item.agentId)).toEqual(['second']);
  cancel!();
  await flush();
  expect(roster()).toEqual([false, true, false]);

  click();
  picker!.selectedItems = [];
  accept!();
  await pumpWhile(() => roster()[1], flush);
  expect(roster()).toEqual([false, false, false]);
  expect(opened).toBe(4);
  panel.disposeListener?.();
});

it('revoke direct grant and reload team.json without restoring access on any backend', async () => {
  scripts.set('first-model', () => ({ text: 'Ready for MCP.' }));
  await screen.select('first');
  await screen.send('Start this member.');
  await pumpWhile(() => !replies('first').includes('Ready for MCP.'), screen.pump);
  const extension = await import('../extension');
  const createProbe = (provider: string, model: string) => {
    const config = new AgentConfigBuilder().fromTemplate('senior-dev')
      .setProviderById(provider).setId(first.id).setName(first.name).setModel(model).build();
    config.backend = provider === 'codex-cli' ? 'codex' : provider === 'claude-cli' ? 'claude' : 'openai-compat';
    config.mcpServers = ['support'];
    const backend = extension.__testBackendWiring({ e2e: true }, config).backend as unknown as {
      mcp?: { hub: MCPHub; grants: () => McpServerGrant[] };
      deps?: { mcp?: { hub: MCPHub; grants: () => McpServerGrant[] } };
    };
    const port = backend.mcp ?? backend.deps?.mcp;
    expect(port).toBeDefined();
    return port!;
  };
  const ports = [createProbe('openai', 'first-model'), createProbe('claude-cli', 'sonnet'), createProbe('codex-cli', 'gpt-5.5')];
  const call = (port: (typeof ports)[number]) => port.hub.executeTool('support__lookup_code', { topic: 'grant' }, port.grants());
  for (const port of ports) await expect(call(port)).resolves.toMatchObject({ status: 'success' });
  // Model a roster previously saved with direct declarations in both stores. Ordinary team exports omit them.
  const saved = storage();
  await saved.saveIntegrationGrants('support', saved.loadAgents(), [
    { agentId: first.id, granted: true }, { agentId: second.id, granted: true },
  ], [], () => {}, () => {});

  let picker!: Picker;
  let accept!: () => void;
  let hide!: () => void;
  host.overrides['vscode.window.createQuickPick'] = () => {
    const control = {
      items: [], selectedItems: [], canSelectMany: false,
      onDidAccept: (callback: () => void) => { accept = callback; },
      onDidHide: (callback: () => void) => { hide = callback; },
      show: () => {}, hide: () => hide(), dispose: () => {},
    };
    picker = control;
    return control;
  };
  host.commands.get('unode.openMarketplace')?.('mcp');
  const panel = panels.filter(entry => entry.viewType === 'unodeMarketplace').at(-1)!;
  await pumpWhile(() => !panel.webview.html.includes('data-command="grantIntegration"'), flush);
  const open = () => panel.receive?.({ command: 'grantIntegration', serverId: 'support' });
  open();
  const fileApi = vscode.workspace.fs;
  const write = fileApi.writeFile.bind(fileApi);
  const writes = vi.spyOn(fileApi, 'writeFile').mockImplementationOnce(write).mockRejectedValueOnce(new Error('rollback failed'));
  const update = context.workspaceState.update.bind(context.workspaceState);
  const roster = vi.spyOn(context.workspaceState, 'update').mockImplementation((key, value) => key.endsWith('.roam.agents')
    ? Promise.reject(new Error('host write failed')) : update(key, value));
  try {
    picker.selectedItems = picker.items.filter(item => item.agentId === second.id);
    accept();
    await pumpWhile(() => !host.warnings.some(warning => warning.includes('Could not restore the team file')), flush, {
      detail: () => JSON.stringify({
        warnings: host.warnings.slice(-4), info: host.infos.slice(-4),
        writes: writes.mock.calls.map(([uri]) => path.basename(uri.fsPath)),
        scopedRosterWrites: roster.mock.calls.filter(([key]) => key.endsWith('.roam.agents')).length,
      }),
    });
    for (const port of ports) await expect(call(port)).resolves.toMatchObject({ status: 'refused', reason: 'consent' });
    expect(panel.posted.some(message => JSON.stringify(message).includes('Paused direct grants: Researcher'))).toBe(true);
    expect(storage().loadAgents().find(member => member.id === first.id)?.mcpServers).toEqual([]);
  } finally {
    writes.mockRestore();
    roster.mockRestore();
  }

  open();
  picker.selectedItems = picker.items.filter(item => item.agentId === second.id);
  accept();
  await pumpWhile(() => storage().integrationGrantRepairs().length > 0, flush);
  for (const port of ports) await expect(call(port)).resolves.toMatchObject({ status: 'refused', reason: 'consent' });
  expect((await storage().loadTeamConfig())?.members.find(member => member.id === first.id)?.mcpServers).toBeUndefined();
  open();
  expect(picker.items.find(item => item.agentId === first.id)?.detail).toBe('Available on the next request');
  hide();
  panel.disposeListener?.();
});

it('saves in Builder, grants in Marketplace and reloads the JSON-memento roster consistently', async () => {
  const form = await builderForm([]);
  await form.submit();
  expect(storage().loadAgents().find(row => row.id === first.id)?.systemPrompt).toContain('Revised researcher instructions.');
  const market = await integrationCard();
  await acceptGrant(market, 'fixture', [first.id]);
  const reloaded = storage();
  expect(reloaded.loadAgents().find(row => row.id === first.id)?.mcpServers).toContain('fixture');
  expect(reloaded.integrationGrantRepairs()).toEqual([]);
  const teamFile = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(workspace, '.unode', 'team.json')));
  expect(JSON.parse(Buffer.from(teamFile).toString()).members.find((row: AgentConfig) => row.id === first.id).mcpServers).toContain('fixture');
  market.disposeListener?.();
});

it('a dirty Builder opened before a Marketplace revoke cannot restore the grant or mount it on the next call', async () => {
  const market = await integrationCard();
  await acceptGrant(market, 'support', [first.id]);
  const firstGrants = storage().loadAgents().find(row => row.id === first.id)!.mcpServers!;
  const form = await builderForm(firstGrants);
  await form.panel.receive?.({ command: 'formDirty' });
  await acceptGrant(market, 'support', []);
  expect(form.panel.posted).toContainEqual(expect.objectContaining({ command: 'mcpServers' }));
  await form.submit();
  expect(host.warnings.at(-1)).toContain('Direct integration grants changed');
  expect(storage().loadAgents().find(row => row.id === first.id)?.mcpServers).not.toContain('support');
  const backend = (await import('../extension')).__testBackendWiring({ e2e: true }, first).backend as unknown as {
    mcp: { hub: MCPHub; grants: () => McpServerGrant[] };
  };
  const { hub, grants } = backend.mcp;
  await expect(hub.executeTool('support__lookup_code', { topic: 'grant' }, grants())).resolves.toMatchObject({
    status: 'refused', reason: 'consent',
  });
  form.panel.disposeListener?.();
  market.disposeListener?.();
});
