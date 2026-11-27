import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * v0.9.106 (F-1, the Owner's 2026-11-14 decision): a check of the PM's that commands Off blocked tells the person once,
 * in the request: the run_checks card says that the check did not run, why, and the steps to the setting; its full
 * refusal is the card's detail. No toast repeats it, Off stays Off, and nothing offers to run it anyway. A later,
 * independent block still reports: the PM's next check in its own request, and another agent's own command.
 * Production entry: activate() with only the VS Code API and the model's HTTP endpoint stood in (see
 * ActivatedExtension.flows.test.ts). This file has its own activate(), so the window's one-time notice is still owed.
 */
const host = await vi.hoisted(async () => (await import('./support/activatedVscode')).createActivatedHost());

vi.mock('vscode', async () => (await import('./support/activatedVscode')).activatedVscodeModule(host));
vi.mock('../host/postWriteDiagnosticsSettle', () => ({ POST_WRITE_DIAGNOSTICS_SETTLE_MS: 0 }));

import { scripts, lastToolResult, replies, installActivatedExtension, pumpWhile, workspace, context, type chatScreen } from './support/activatedHarness';
import { bundledReferenceCatalog } from '../models/spend/BundledCatalogs';
import { catalogIsStale } from '../models/spend/PriceCatalog';
import { TeamViewProvider } from '../views/TeamViewProvider';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// The window's setting changes reach activation through onDidChangeConfiguration, as an edit in Settings does.
type ConfigurationChange = { affectsConfiguration(section: string): boolean };
const configurationListeners: Array<(event: ConfigurationChange) => void> = [];
host.overrides['vscode.workspace.onDidChangeConfiguration'] = (listener: (event: ConfigurationChange) => void) => {
  configurationListeners.push(listener);
  return { dispose() {} };
};
// Every command the extension runs, by name: opening Settings or enabling commands would show here.
const executed: string[] = [];
host.overrides['vscode.commands.executeCommand'] = async (name: string) => { executed.push(name); return undefined; };

let screen: ReturnType<typeof chatScreen>;
let chatProvider: any;
installActivatedExtension(host, (ready) => { chatProvider = ready.chatProvider; screen = ready.screen; });

async function setUserSetting(key: string, value: unknown): Promise<void> {
  const vscode = (await import('vscode')) as any;
  await vscode.workspace.getConfiguration('unode').update(key, value, 1);
  const name = `unode.${key}`;
  for (const listener of configurationListeners) {
    listener({ affectsConfiguration: (section) => section === name || name.startsWith(`${section}.`) });
  }
}

async function userSetting(key: string): Promise<unknown> {
  const vscode = (await import('vscode')) as any;
  return vscode.workspace.getConfiguration('unode').get(key);
}

const REASON = 'Commands are disabled, so UnodeAi did not run';
const BLOCK_TOAST = /Command blocked/;
const ranMarker = path.join(workspace, 'checks-ran.txt');
type ChatItem = Record<string, any>;
const items = (): ChatItem[] => (chatProvider as any).currentState().messages as ChatItem[];
const said = (item: ChatItem): string => [item.text, item.summary, item.detail].filter((part) => typeof part === 'string').join('\n');
const checkCards = () => items().filter((item) => item.kind === 'tool' && item.name === 'run_checks');
const lastCheckRow = (): string | undefined => {
  const summaries = items().filter((item) => item.kind === 'requestSummary');
  const rows = summaries.at(-1)?.view?.sections?.flatMap((section: { rows: Array<{ label: string; value: string }> }) => section.rows) ?? [];
  return rows.find((row: { label: string }) => row.label === 'Last completion check')?.value;
};

describe('v0.9.106 F-1: a check of the PM\'s that commands Off blocked is told once, in its request', () => {
  it('the PM\'s run_checks under Off: one card with the reason and the steps, no toast, Off unchanged, nothing ran', async () => {
    // The project's own check, found by detection (no check is configured): it would leave a marker if it ran.
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'f1', private: true,
      scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'checks-ran.txt\', \'ran\')"' } }));
    await setUserSetting('commandApproval', 'none');
    let toolText = '';
    scripts.set('pm-model', (request) => {
      const tool = lastToolResult(request);
      if (tool) { toolText = tool; return { text: 'The checks could not run.' }; }
      return { calls: [{ name: 'run_checks', args: {} }] };
    });
    await screen.select('pm');
    host.warnings.length = 0; executed.length = 0;
    await screen.send('Please run the checks.');
    await pumpWhile(() => !replies('pm').includes('The checks could not run.') || lastCheckRow() === undefined, screen.pump,
      { detail: () => JSON.stringify({ replies: replies('pm'), warnings: host.warnings, toolText }) });

    // The check did not run, and the model was told so.
    expect(fs.existsSync(ranMarker)).toBe(false);
    expect(toolText).toMatch(/^Completion checks not run \(policy-blocked\): Commands are disabled/);
    // One record in the request: the run_checks card, refused, with the reason in its summary and the full refusal,
    // with the steps to the setting, as its detail. No other chat item repeats the reason.
    const cards = checkCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ phase: 'result', ok: false });
    expect(cards[0].summary).toContain(REASON);
    expect(cards[0].detail).toContain('1. Run UnodeAi: Open Settings from the Command Palette.');
    expect(cards[0].detail).toContain('2. Open Team > Permissions > Commands.');
    expect(cards[0].detail).toContain('3. In User settings, choose all or ask.');
    expect(items().filter((item) => said(item).includes(REASON)), JSON.stringify(items().map(said))).toEqual([cards[0]]);
    // The fact that the check did not run stays in the request's summary.
    expect(lastCheckRow()).toBe('not run — blocked by current permissions');
    // No toast: neither "Command blocked by unode.commandApproval" with Open Settings nor the one-time notice with
    // Enable Commands. Nothing opened Settings or enabled commands, and Off is still Off.
    expect(host.warnings.filter((text) => BLOCK_TOAST.test(text)), JSON.stringify(host.warnings)).toEqual([]);
    expect(executed.filter((name) => name === 'unode.enableCommands' || name === 'workbench.action.openSettings')).toEqual([]);
    expect(await userSetting('commandApproval')).toBe('none');
  });

  it('a later, independent block still reports: the PM\'s next check in its own request, and Dev\'s own command', async () => {
    // The PM's next request runs its check again: it has its own card, with the reason, in its own request.
    scripts.set('pm-model', (request) => (lastToolResult(request) ? { text: 'Still not run.' }
      : { calls: [{ name: 'run_checks', args: {} }] }));
    await screen.select('pm');
    host.warnings.length = 0;
    await screen.send('Try the checks again.');
    await pumpWhile(() => !replies('pm').includes('Still not run.'), screen.pump);
    expect(checkCards()).toHaveLength(2);
    expect(checkCards()[1].summary).toContain(REASON);
    expect(host.warnings.filter((text) => BLOCK_TOAST.test(text))).toEqual([]);

    // Another agent's own command under Off is a different block, and its chat still says what did not run. (On this
    // route the refusal comes before the command policy, so it never showed the one-time notice; that the PM's checks
    // leave the notice owed is proved in CommandPolicy.test.ts and AgentCommandPolicy.test.ts.)
    const command = 'node -e "require(\'fs\').writeFileSync(\'dev-ran.txt\', \'ran\')"';
    scripts.set('dev-model', (request) => (lastToolResult(request) ? { text: 'The command was not run.' }
      : { calls: [{ name: 'run_command', args: { command } }] }));
    await screen.select('dev');
    await screen.send('Run the command.');
    await pumpWhile(() => !replies('dev').includes('The command was not run.'), screen.pump,
      { detail: () => JSON.stringify({ replies: replies('dev'), warnings: host.warnings }) });
    expect(fs.existsSync(path.join(workspace, 'dev-ran.txt'))).toBe(false);
    expect(replies('dev').some((text) => text.startsWith(REASON)), JSON.stringify(replies('dev'))).toBe(true);
    expect(await userSetting('commandApproval')).toBe('none');
  });
});

// v0.9.106 quiet first screen: what first use hides while the roster is empty is shown as before in a window that opens
// with agents (the PM, Dev and Writer here). The empty-roster side is in ActivatedFirstUse.flows.test.ts.
describe('v0.9.106 a window that opens with agents: the Status key and the stale reference-price reminder as before', () => {
  it('the Team panel has its Status key, and the stale reminder is shown once, when the reference is stale', async () => {
    const team = String((host.views.get(TeamViewProvider.viewType) as any)._getHtml({ cspSource: 'test:', asWebviewUri: (u: unknown) => u }));
    expect(team).toContain('<summary>Status key</summary>');
    // Whether the bundled Unode reference is stale depends on today's date; the reminder follows it.
    const catalog = bundledReferenceCatalog('unode')!;
    const stale = catalogIsStale(catalog, Date.now());
    const reminder = `The Unode reference prices UnodeAi shows were captured ${catalog.capturedAt.slice(0, 10)} and are now stale. Update them to keep estimates current.`;
    if (stale) {
      await pumpWhile(() => !host.infos.includes(reminder), screen.pump, { detail: () => JSON.stringify(host.infos) });
      expect(context.globalState.get<Record<string, string>>('unode.spend.staleReferenceRemindedAt')).toHaveProperty(catalog.catalogId);
    }
    expect(host.infos.filter((text) => text === reminder)).toHaveLength(stale ? 1 : 0);
  });
});
