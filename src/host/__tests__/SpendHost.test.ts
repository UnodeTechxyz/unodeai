import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => ({
  window: { showWarningMessage: vi.fn(), showInformationMessage: vi.fn(), createStatusBarItem: vi.fn() },
  commands: { executeCommand: vi.fn(), registerCommand: vi.fn() },
  StatusBarAlignment: { Right: 2 },
  ThemeColor: class {},
  QuickPickItemKind: { Separator: -1 },
  workspace: { createFileSystemWatcher: vi.fn(), getConfiguration: vi.fn() },
  RelativePattern: class {},
}));

import { alertChatText, readBudgetFile } from '../SpendHost';
import type { SpendAlert } from '../SpendCoordinator';

const roots: string[] = [];
async function project(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'unode-budget-'));
  roots.push(root);
  await fsp.mkdir(path.join(root, '.unode'), { recursive: true });
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }); });

const valid = JSON.stringify({ schemaVersion: 1, max: { request: { tokens: 100 } } });

describe('.unode/budget.json reader', () => {
  it('reads a valid proposal inside the project', async () => {
    const root = await project();
    await fsp.writeFile(path.join(root, '.unode', 'budget.json'), valid);
    const state = await readBudgetFile(root);
    expect(state.state).toBe('valid');
  });

  it('is absent without a file or a folder', async () => {
    expect(await readBudgetFile(undefined)).toEqual({ state: 'none' });
    expect(await readBudgetFile(await project())).toEqual({ state: 'none' });
  });

  it('refuses a link that resolves outside the project', async () => {
    const root = await project();
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'unode-budget-outside-'));
    roots.push(outside);
    await fsp.writeFile(path.join(outside, 'budget.json'), valid);
    try {
      await fsp.rm(path.join(root, '.unode'), { recursive: true, force: true });
      // A junction needs no privilege on Windows; elsewhere this is an ordinary directory symlink.
      await fsp.symlink(outside, path.join(root, '.unode'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // the platform refused to create a link; nothing to test here
    }
    expect(await readBudgetFile(root)).toEqual({ state: 'invalid', reason: 'it resolves outside the project folder' });
  });

  it('refuses invalid UTF-8, oversize files and unsafe JSON', async () => {
    const root = await project();
    const file = path.join(root, '.unode', 'budget.json');
    await fsp.writeFile(file, Buffer.from([0x7b, 0xff, 0x7d]));
    expect(await readBudgetFile(root)).toEqual({ state: 'invalid', reason: 'it is not valid UTF-8' });
    await fsp.writeFile(file, ' '.repeat(64 * 1024 + 1));
    expect(await readBudgetFile(root)).toEqual({ state: 'invalid', reason: 'it is larger than 64 KiB' });
    await fsp.writeFile(file, '{"schemaVersion":1,"max":{"request":{"tokens":1,"tokens":2}}}');
    expect(await readBudgetFile(root)).toMatchObject({ state: 'invalid' });
  });
});

describe('alert text', () => {
  const base: SpendAlert = {
    key: 'k', loudness: 'over-target', threshold: 150, scope: 'request', dimension: 'tokens', requestId: 'r',
    valueText: '150 tokens', targetText: '100 tokens', basisText: 'reported tokens', repositoryNarrowed: false,
    reset: { scope: 'request', requestId: 'r' }, stopToken: 't',
  };

  it('says work is continuing while it is, and never claims a stop', () => {
    const loud = alertChatText(base, true);
    expect(loud).toMatch(/Over target — work is continuing/);
    expect(loud).not.toMatch(/blocked|hard cap|stopped by budget/i);
    const quiet = alertChatText({ ...base, loudness: 'quiet', threshold: 80 }, true);
    expect(quiet).toMatch(/80% of its spend reminder target/);
    expect(quiet).toMatch(/Work continues/);
  });

  it('says nothing is running when the crossing usage arrives after the work ended (field finding F9)', () => {
    const loud = alertChatText(base, false);
    expect(loud).toBe('UnodeAi: Over target. This request is at 150% of its spend reminder target: 150 tokens of 100 tokens '
      + '(reported tokens). Nothing in this request is running right now.');
    const quiet = alertChatText({ ...base, loudness: 'quiet', threshold: 80 }, false);
    expect(quiet).toMatch(/Nothing in this request is running right now\.$/);
    const project = alertChatText({ ...base, scope: 'project-period', periodId: '2026-09-28@UTC' }, false);
    expect(project).toMatch(/No agent is working right now\.$/);
    for (const text of [loud, quiet, project]) expect(text.toLowerCase()).not.toMatch(/work is continuing|work continues/);
  });

  it('the persistent badge says work is continuing only while an agent is in a turn (field finding F3)', async () => {
    const { spendBadgeText } = await import('../SpendHost');
    expect(spendBadgeText(311, true)).toBe('Over spend target (311%) — work is continuing');
    expect(spendBadgeText(311, false)).toBe('Over spend target (311%)');
  });

  it('names an accepted project-suggested target', () => {
    expect(alertChatText({ ...base, repositoryNarrowed: true }, true)).toMatch(/project-suggested target accepted by you/);
  });

  it('asks the request itself whether it is still running, for the chat line and the dialog (field finding F9)', async () => {
    const vscode = await import('vscode');
    const warn = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;
    warn.mockReset();
    warn.mockResolvedValue(undefined);
    (vscode.window.createStatusBarItem as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ show: vi.fn(), hide: vi.fn(), dispose: vi.fn() });
    const { SpendHost } = await import('../SpendHost');
    const storage = await fsp.mkdtemp(path.join(os.tmpdir(), 'unode-spendhost-'));
    roots.push(storage);
    const notices: string[] = [];
    const running = new Set<string>(['live-request']);
    const spend = new SpendHost({
      context: { globalStorageUri: { fsPath: storage }, globalState: { get: () => undefined, update: async () => undefined } } as never,
      primaryRoot: undefined,
      log: () => undefined,
      resolveRoute: () => undefined,
      agentName: () => undefined,
      stopRequest: () => 0,
      readUserSetting: ((_key: string, fallback: unknown) => fallback) as never,
      writeUserSetting: async () => undefined,
      refreshAccountPrices: async () => undefined,
      pricingUrl: () => undefined,
      metadataFetch: (async () => ({ ok: false, status: 500, text: async () => '' })) as never,
      ensureMetadataConsent: async () => false,
      postChatNotice: (_agentId, _key, text) => { notices.push(text); return true; },
      refreshViews: () => undefined,
      openDashboard: async () => undefined,
      openSettingsSpend: () => undefined,
      // Another request is still working; only the alert's own request decides the wording.
      workRunning: () => true,
      requestRunning: (requestId) => running.has(requestId),
    });
    const present = (alert: SpendAlert) => (spend as unknown as { presentThreshold(alert: SpendAlert): void }).presentThreshold(alert);
    present({ ...base, key: 'stopped', requestId: 'stopped-request', rootAgentId: 'pm' });
    present({ ...base, key: 'live', requestId: 'live-request', rootAgentId: 'pm' });
    expect(notices[0]).toMatch(/^UnodeAi: Over target\. .*Nothing in this request is running right now\.$/);
    expect(notices[1]).toMatch(/^UnodeAi: Over target — work is continuing\./);
    expect(warn.mock.calls[0][0]).toBe('Over target. This request is at 150% of its spend reminder target. Nothing in this request is running right now.');
    expect(warn.mock.calls[1][0]).toBe('Over target — work is continuing. This request is at 150% of its spend reminder target.');
    // The buttons do not change: Stop this request still stops a turn that starts after the reminder.
    expect(warn.mock.calls[0].slice(2)).toEqual(warn.mock.calls[1].slice(2));
    spend.dispose();
  });
});

describe('first-run reference choice', () => {
  async function host(answer: string | undefined) {
    const vscode = await import('vscode');
    const show = vscode.window.showInformationMessage as unknown as ReturnType<typeof vi.fn>;
    show.mockReset();
    show.mockResolvedValue(answer);
    (vscode.window.createStatusBarItem as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ show: vi.fn(), hide: vi.fn(), dispose: vi.fn() });
    const state = new Map<string, unknown>();
    const writes: Array<[string, unknown]> = [];
    const { SpendHost } = await import('../SpendHost');
    const storage = await fsp.mkdtemp(path.join(os.tmpdir(), 'unode-spendhost-'));
    roots.push(storage);
    const spend = new SpendHost({
      context: {
        globalStorageUri: { fsPath: storage },
        globalState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } },
      } as never,
      primaryRoot: undefined,
      log: () => undefined,
      resolveRoute: () => undefined,
      agentName: () => undefined,
      stopRequest: () => 0,
      readUserSetting: ((key: string, fallback: unknown) => key === 'spend.referencePriceMode' ? 'unselected' : fallback) as never,
      writeUserSetting: async (key, value) => { writes.push([key, value]); },
      refreshAccountPrices: async () => undefined,
      pricingUrl: () => undefined,
      metadataFetch: (async () => ({ ok: false, status: 500, text: async () => '' })) as never,
      ensureMetadataConsent: async () => false,
      postChatNotice: () => false,
      refreshViews: () => undefined,
      openDashboard: async () => undefined,
      openSettingsSpend: () => undefined,
    });
    const offer = (spend as unknown as { offerReferencePriceChoice(context: { connectionName: string; modelId: string }): Promise<void> }).offerReferencePriceChoice.bind(spend);
    return { offer, show, writes, state };
  }

  it('records nothing when dismissed, and does not ask again within seven days', async () => {
    const { offer, show, writes } = await host(undefined);
    await offer({ connectionName: 'My gateway', modelId: 'm1' });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][1]).toMatchObject({ modal: true });
    expect(writes).toEqual([]);
    await offer({ connectionName: 'My gateway', modelId: 'm1' });
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('records exactly the chosen mode', async () => {
    const { offer, writes } = await host('Use Roam estimate for dollar reminders');
    await offer({ connectionName: 'My gateway', modelId: 'm1' });
    expect(writes).toEqual([['spend.referencePriceMode', 'roam']]);
  });
});
