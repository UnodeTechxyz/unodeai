import { beforeAll, expect, it, vi } from 'vitest';

const host = await vi.hoisted(async () => (await import('./support/activatedVscode')).createActivatedHost());
vi.mock('vscode', async () => (await import('./support/activatedVscode')).activatedVscodeModule(host));

import { PersistenceManager } from '../state/PersistenceManager';
import { RootScopedWorkspaceState } from '../state/RootScopedWorkspaceState';
import { agent, context, flush, installActivatedExtension, pumpWhile, replies, scripts, workspace } from './support/activatedHarness';
import { recordPanels } from './support/setupGuidePage';

const panels = recordPanels(host);
const state = () => new RootScopedWorkspaceState(context.workspaceState as never, workspace);
const storage = () => new PersistenceManager(context as never, undefined, () => workspace, undefined, undefined, state());
const paused = { id: 'paused', name: 'Paused fixture', transport: 'stdio' as const, command: process.execPath };

// Open a new extension instance with the repair flag left by an earlier window.
beforeAll(async () => {
  await storage().saveHostMcpServers([paused]);
  await state().update('unode.integrationConfigRepairs.v1', ['paused']);
});
let screen: Parameters<Parameters<typeof installActivatedExtension>[1]>[0]['screen'];
installActivatedExtension(host, ready => { screen = ready.screen; }, {
  agents: [{ ...agent('senior-dev', 'member', 'Member', 'member-model'), mcpServers: ['paused'] }],
});

it('a saved configuration repair survives reload, opens Integrations from the start notice and clears only on Edit', async () => {
  host.commands.get('unode.openMarketplace')?.('mcp');
  const panel = panels.find(entry => entry.viewType === 'unodeMarketplace')!;
  await pumpWhile(() => !panel.webview.html.includes('Connection: failed'), flush);
  expect(panel.webview.html).toContain('Saved configuration could not be verified. Open Edit to review and save.');
  expect(storage().integrationConfigNeedsRepair('paused')).toBe(true);

  const command = vi.fn();
  const notice = vi.fn(async (_text: string, ...actions: unknown[]) => actions.includes('Open Integrations') ? 'Open Integrations' : undefined);
  host.overrides['vscode.window.showWarningMessage'] = notice;
  host.overrides['vscode.commands.executeCommand'] = command;
  scripts.set('member-model', () => ({ text: 'Working without the paused integration.' }));
  await screen.select('member');
  await screen.send('Start.');
  await pumpWhile(() => !replies('member').includes('Working without the paused integration.'), screen.pump);
  expect(notice).toHaveBeenCalledWith(expect.stringContaining('choose Edit to review and save'), 'Open Integrations');
  expect(notice.mock.calls.flatMap(([, ...actions]) => actions)).not.toContain('Retry');
  expect(command).toHaveBeenCalledWith('unode.openMarketplace', 'mcp');

  host.overrides['vscode.window.showInputBox'] = async (input: { value: string }) => input.value;
  host.overrides['vscode.window.showQuickPick'] = async (options: unknown[]) => options[0];
  panel.receive?.({ command: 'editIntegration', serverId: 'paused' });
  await pumpWhile(() => storage().integrationConfigNeedsRepair('paused'), flush);
  expect(storage().loadHostMcpServers()).toMatchObject([paused]);
  expect(storage().loadApprovedMcpServers()).toEqual([]);
  panel.disposeListener?.();
});
