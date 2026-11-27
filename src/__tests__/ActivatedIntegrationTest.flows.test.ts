import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as path from 'node:path';

const host = await vi.hoisted(async () => (await import('./support/activatedVscode')).createActivatedHost());
vi.mock('vscode', async () => (await import('./support/activatedVscode')).activatedVscodeModule(host));

import { approvalKey } from '../mcp/McpApproval';
import { PersistenceManager } from '../state/PersistenceManager';
import { RootScopedWorkspaceState } from '../state/RootScopedWorkspaceState';
import type { MCPServerConfig } from '../types';
import { agent, context, flush, installActivatedExtension, pumpWhile, replies, requests, scripts, workspace } from './support/activatedHarness';
import { recordPanels } from './support/setupGuidePage';

const panels = recordPanels(host);
const storage = () => new PersistenceManager(context as never, undefined, () => workspace, undefined, undefined,
  new RootScopedWorkspaceState(context.workspaceState as never, workspace));
const fixture = path.join(process.cwd(), 'src', 'mcp', '__tests__', 'fixtures', 'stdio-mcp-server.cjs');
const privateConfig: MCPServerConfig = { id: 'fixture', name: 'Test Fixture', transport: 'stdio', command: process.execPath, args: [fixture] };
const hungConfig: MCPServerConfig = {
  ...privateConfig, id: 'hung', name: 'Hung Fixture', args: [fixture, 'hang-list'],
};
const removalConfig: MCPServerConfig = { ...privateConfig, id: 'removal', name: 'Removal Fixture' };
beforeAll(async () => { await storage().saveHostMcpServers([privateConfig, hungConfig, removalConfig]); });
let screen: Parameters<Parameters<typeof installActivatedExtension>[1]>[0]['screen'];
installActivatedExtension(host, ready => { screen = ready.screen; }, { agents: [agent('senior-dev', 'tester', 'Tester', 'tester-model')] });
afterAll(async () => { await (await import('../extension')).deactivate(); });

async function marketplace() {
  host.commands.get('unode.openMarketplace')?.('mcp');
  const panel = panels.filter(candidate => candidate.viewType === 'unodeMarketplace').at(-1)!;
  await pumpWhile(() => !panel.webview.html.includes('data-command="testIntegration"'), flush);
  const view = () => {
    const update = panel.posted.filter(message => (message as { command?: string }).command === 'viewState').at(-1) as
      { ownedIntegrationsHtml?: string } | undefined;
    return update?.ownedIntegrationsHtml ?? panel.webview.html;
  };
  return { panel, view };
}

it.each([undefined, 'Skip'])('Test cancels before connecting when the launch prompt returns %s', async choice => {
  const originalWarning = host.overrides['vscode.window.showWarningMessage'];
  const approval = vi.fn(async () => choice);
  host.overrides['vscode.window.showWarningMessage'] = approval;
  const { panel, view } = await marketplace();
  try {
    panel.receive?.({ command: 'testIntegration', serverId: 'fixture' });
    await pumpWhile(() => !view().includes('Cancelled before connecting.'), flush);
    expect(approval).toHaveBeenCalledWith(expect.stringContaining('Start a test instance'), { modal: true }, 'Skip', 'Approve & Test');
    expect(view()).not.toContain('Connected ·');
    expect(storage().loadApprovedMcpServers()).not.toContain(approvalKey(privateConfig, workspace));
  } finally {
    host.overrides['vscode.window.showWarningMessage'] = originalWarning;
    panel.disposeListener?.();
  }
});

it('Test approval persists the exact fingerprint used by the next live mount', async () => {
  const originalWarning = host.overrides['vscode.window.showWarningMessage'];
  const approval = vi.fn(async (message: string) => message.includes('Start a test instance') ? 'Approve & Test' : undefined);
  host.overrides['vscode.window.showWarningMessage'] = approval;
  const { panel, view } = await marketplace();
  try {
    panel.receive?.({ command: 'testIntegration', serverId: 'fixture' });
    await pumpWhile(() => !view().includes('Connected · 3 tools found'), flush);
    expect(view()).toContain('Connection: unmounted');
    expect(storage().loadApprovedMcpServers()).toContain(approvalKey(privateConfig, workspace));
    expect(storage().loadAgents()[0].mcpServers ?? []).toEqual([]);
    expect(approval.mock.calls.filter(([message]) => message.includes('Start a test instance'))).toHaveLength(1);
    host.overrides['vscode.window.createQuickPick'] = () => {
      let accept: () => void;
      const control = {
        items: [] as Array<{ agentId: string }>,
        selectedItems: [] as Array<{ agentId: string }>,
        onDidAccept: (next: () => void) => { accept = next; },
        onDidHide: () => {},
        show: () => { control.selectedItems = control.items.filter(item => item.agentId === 'tester'); accept(); },
        hide: () => {}, dispose: () => {},
      };
      return control;
    };
    panel.receive?.({ command: 'grantIntegration', serverId: 'fixture' });
    await pumpWhile(() => !storage().loadAgents()[0].mcpServers?.includes('fixture'), flush);
    scripts.set('tester-model', () => ({ text: 'Tools ready.' }));
    await screen.select('tester');
    await screen.send('Check the tools.');
    await pumpWhile(() => !replies('tester').includes('Tools ready.'), screen.pump);
    expect(approval.mock.calls.some(([message]) => message.includes('Mount it for this team'))).toBe(false);
    expect(requests.filter(request => request.model === 'tester-model').flatMap(request => request.tools ?? []))
      .toContainEqual(expect.objectContaining({ function: expect.objectContaining({ name: 'fixture__lookup_code' }) }));
  } finally {
    host.overrides['vscode.window.showWarningMessage'] = originalWarning;
    panel.disposeListener?.();
  }
});

it('Stop cancels a pending test without publishing tool availability', async () => {
  const originalWarning = host.overrides['vscode.window.showWarningMessage'];
  host.overrides['vscode.window.showWarningMessage'] = async () => 'Approve & Test';
  const { panel, view } = await marketplace();
  try {
    panel.receive?.({ command: 'testIntegration', serverId: 'hung' });
    await pumpWhile(() => !view().includes('data-command="stopIntegrationTest"'), flush);
    panel.receive?.({ command: 'stopIntegrationTest', serverId: 'hung' });
    await pumpWhile(() => !view().includes('Test: Cancelled.'), flush);
    expect(view()).not.toContain('data-command="stopIntegrationTest"');
    expect(storage().loadAgents()[0].mcpServers).not.toContain('hung');
  } finally {
    host.overrides['vscode.window.showWarningMessage'] = originalWarning;
    panel.disposeListener?.();
  }
});

it('an edited fingerprint cannot publish the previous test result or approval', async () => {
  const { panel, view } = await marketplace();
  const originalWarning = host.overrides['vscode.window.showWarningMessage'];
  let allow!: (choice: string) => void;
  const approval = vi.fn(() => new Promise<string>(finish => { allow = finish; }));
  host.overrides['vscode.window.showWarningMessage'] = approval;
  const original = storage().loadHostMcpServers().find(row => row.id === 'hung')!;
  const prior = storage().loadApprovedMcpServers();
  // Use a new, unapproved fingerprint because the earlier test approved the hang-list configuration.
  host.overrides['vscode.window.showInputBox'] = async (input: { prompt: string; value: string }) =>
    input.prompt === 'Command arguments as a JSON array' ? JSON.stringify([fixture, 'hang-initialize']) : input.value;
  host.overrides['vscode.window.showQuickPick'] = async (options: unknown[]) => options[0];
  try {
    panel.receive?.({ command: 'editIntegration', serverId: 'hung' });
    await pumpWhile(() => storage().loadHostMcpServers().find(row => row.id === 'hung')?.args?.[1] !== 'hang-initialize', flush);
    await flush();
    const testConfig = storage().loadHostMcpServers().find(row => row.id === 'hung')!;
    expect(approvalKey(original, workspace)).not.toBe(approvalKey(testConfig, workspace));
    panel.receive?.({ command: 'testIntegration', serverId: 'hung' });
    await pumpWhile(() => approval.mock.calls.length === 0, flush);
    host.overrides['vscode.window.showInputBox'] = async (input: { prompt: string; value: string }) =>
      input.prompt === 'Command arguments as a JSON array' ? JSON.stringify([fixture]) : input.value;
    panel.receive?.({ command: 'editIntegration', serverId: 'hung' });
    await pumpWhile(() => view().includes('data-command="stopIntegrationTest"'), flush);
    allow('Approve & Test');
    await flush();
    const editedCard = view().split('<article').find(block => block.includes('data-server-id="hung"'));
    expect(editedCard).toBeDefined();
    expect(editedCard).not.toContain('Connected ·');
    expect(storage().loadApprovedMcpServers()).toEqual(prior);
  } finally {
    host.overrides['vscode.window.showWarningMessage'] = originalWarning;
    panel.disposeListener?.();
  }
});

it('Remove closes admission to Grant and Test and cancels an approval write already in flight', async () => {
  const { panel } = await marketplace();
  const serverId = removalConfig.id;
  const key = approvalKey(removalConfig, workspace);
  expect(storage().loadApprovedMcpServers()).not.toContain(key);
  const originalWarning = host.overrides['vscode.window.showWarningMessage'];
  const priorPicker = host.overrides['vscode.window.createQuickPick'];
  const approval = vi.fn(async (message: string) => message.includes('Start a test instance') ? 'Approve & Test'
    : message.includes('Remove integration') ? 'Remove & Revoke' : undefined);
  const picker = vi.fn(() => { throw new Error('No picker should open during Remove.'); });
  host.overrides['vscode.window.showWarningMessage'] = approval;
  host.overrides['vscode.window.createQuickPick'] = picker;
  const update = context.workspaceState.update.bind(context.workspaceState);
  let release!: () => void;
  const parked = new Promise<void>(resolve => { release = resolve; });
  let approvalWriteStarted = false;
  const writes = vi.spyOn(context.workspaceState, 'update').mockImplementation(async (name, value) => {
    if (name.endsWith('.unode.approvedMcpServers') && Array.isArray(value) && value.includes(key)) {
      approvalWriteStarted = true;
      await parked;
    }
    await update(name, value);
  });
  try {
    panel.receive?.({ command: 'testIntegration', serverId });
    await pumpWhile(() => !approvalWriteStarted, flush);
    panel.receive?.({ command: 'removeIntegration', serverId });
    await pumpWhile(() => !approval.mock.calls.some(([message]) => message.includes('Remove integration')), flush);
    await flush();
    panel.receive?.({ command: 'grantIntegration', serverId });
    panel.receive?.({ command: 'testIntegration', serverId });
    expect(picker).not.toHaveBeenCalled();
    await pumpWhile(() => !host.infos.some(message => message.includes('being removed'))
      || !approval.mock.calls.some(([message]) => message.includes('being removed')), flush);
    expect(approval.mock.calls.filter(([message]) => message.includes('Start a test instance'))).toHaveLength(1);
    release();
    await pumpWhile(() => storage().loadHostMcpServers().some(row => row.id === serverId), flush);
    expect(storage().loadApprovedMcpServers()).not.toContain(key);
    expect(storage().loadAgents()[0].mcpServers ?? []).not.toContain(serverId);
  } finally {
    release();
    writes.mockRestore();
    host.overrides['vscode.window.showWarningMessage'] = originalWarning;
    host.overrides['vscode.window.createQuickPick'] = priorPicker;
    panel.disposeListener?.();
  }
});
