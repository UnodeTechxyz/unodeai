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
import type { SpendAlert, SpendRoute } from '../SpendCoordinator';
import type { SpendLedger } from '../../state/SpendStore';
import { catalogFromNewApiPricing, catalogIsStale, lookupCatalogModel } from '../../models/spend/PriceCatalog';
import type { PriceFetch } from '../../models/LivePriceService';

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

  // v0.9.97 P1: a link into a project folder whose name starts with two dots stays in the project; one into a sibling
  // whose name starts like the project's does not (the file-effects design, §5).
  it('reads through a link into a "..name" folder of the project, and refuses one into a sibling', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'unode-budget-dots-'));
    roots.push(base);
    const root = path.join(base, 'project');
    const sibling = path.join(base, 'project-cfg');
    await fsp.mkdir(path.join(root, '..cfg'), { recursive: true });
    await fsp.mkdir(sibling);
    await fsp.writeFile(path.join(root, '..cfg', 'budget.json'), valid);
    await fsp.writeFile(path.join(sibling, 'budget.json'), valid);
    const kind = process.platform === 'win32' ? 'junction' : 'dir';
    await fsp.symlink(path.join(root, '..cfg'), path.join(root, '.unode'), kind);
    expect((await readBudgetFile(root)).state).toBe('valid');
    await fsp.rm(path.join(root, '.unode'));
    await fsp.symlink(sibling, path.join(root, '.unode'), kind);
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
  const TOKEN_ONLY = 'Use token reminders only';
  const UNODE = 'Use Unode estimate for dollar reminders';
  const ROAM = 'Use Roam estimate for dollar reminders';
  // v0.9.94: the name one gateway gives a model both bundled references list as `deepseek-v4.1-flash`.
  const GATEWAY_ID = 'deepseek/deepseek-v4.1-flash';
  const gateway: SpendRoute = { connectionId: 'openrouter', connectionName: 'OpenRouter', route: 'gateway' };

  const hosts: Array<{ dispose(): void }> = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const spend of hosts.splice(0)) spend.dispose();
  });

  const pricingBody = (rows: Record<string, number>) => ({
    group_ratio: { default: 1 },
    data: Object.entries(rows).map(([name, ratio]) => ({ model_name: name, quota_type: 0, model_ratio: ratio, completion_ratio: 1 })),
  });

  async function host(answer: string | undefined, options: { route?: SpendRoute } = {}) {
    const vscode = await import('vscode');
    const show = vscode.window.showInformationMessage as unknown as ReturnType<typeof vi.fn>;
    show.mockReset();
    show.mockResolvedValue(answer);
    (vscode.window.createStatusBarItem as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ show: vi.fn(), hide: vi.fn(), dispose: vi.fn() });
    const state = new Map<string, unknown>();
    const writes: Array<[string, unknown]> = [];
    const logs: string[] = [];
    // The setting behaves as the real one does: what the choice writes is what the next read returns.
    let mode: unknown = 'unselected';
    const { SpendHost } = await import('../SpendHost');
    const storage = await fsp.mkdtemp(path.join(os.tmpdir(), 'unode-spendhost-'));
    roots.push(storage);
    const spend = new SpendHost({
      context: {
        globalStorageUri: { fsPath: storage },
        globalState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } },
      } as never,
      primaryRoot: undefined,
      log: (message) => { logs.push(message); },
      resolveRoute: () => options.route,
      agentName: () => undefined,
      stopRequest: () => 0,
      readUserSetting: ((key: string, fallback: unknown) => key === 'spend.referencePriceMode' ? mode : fallback) as never,
      writeUserSetting: async (key, value) => {
        writes.push([key, value]);
        if (key === 'spend.referencePriceMode') mode = value;
      },
      refreshAccountPrices: async () => undefined,
      pricingUrl: () => undefined,
      metadataFetch: (async () => ({ ok: false, status: 500, text: async () => '' })) as never,
      ensureMetadataConsent: async () => false,
      postChatNotice: () => false,
      refreshViews: () => undefined,
      openDashboard: async () => undefined,
      openSettingsSpend: () => undefined,
    });
    hosts.push(spend);
    const offer = (spend as unknown as { offerReferencePriceChoice(context: { connectionName: string; modelId: string }): Promise<void> }).offerReferencePriceChoice.bind(spend);
    // The choice is the only modal shown through showInformationMessage; the stale-catalog reminder is not one.
    const dialogs = () => show.mock.calls
      .filter((call) => (call[1] as { modal?: boolean } | undefined)?.modal === true)
      .map((call) => ({ message: call[0] as string, detail: (call[1] as { detail: string }).detail, buttons: call.slice(2) as string[] }));
    const events = () => (spend as unknown as { ledger: SpendLedger }).ledger.snapshot().events.map((stored) => stored.event);
    const receipts = () => events().flatMap((event) => event.kind === 'usage-receipt' ? [event.receipt] : []);
    // One turn of 1M reported input tokens: `begin` starts it, `finish` ends it and waits for its record.
    const begin = (usageUnitId: string, modelId: string) => {
      spend.coordinator.beginUsageUnit({ usageUnitId, requestId: 'req1', agentId: 'pm', modelId });
      spend.coordinator.noteModelRequest(usageUnitId);
    };
    const finish = async (usageUnitId: string) => {
      const projection = spend.coordinator.settleUsageUnit(usageUnitId, { inputTokens: 1_000_000, outputTokens: 0, usageBasis: 'reported' });
      // The post-turn price resolution runs detached after the receipt is durable; give it its turns to finish.
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await spend.coordinator.drained();
      }
      return projection;
    };
    return { spend, storage, offer, show, writes, state, logs, dialogs, events, receipts, begin, finish, setMode: (value: unknown) => { mode = value; } };
  }

  it('records nothing when dismissed, and does not ask again within seven days', async () => {
    const { offer, show, writes } = await host(undefined);
    await offer({ connectionName: 'My gateway', modelId: 'claude-opus-5' });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][1]).toMatchObject({ modal: true });
    expect(writes).toEqual([]);
    await offer({ connectionName: 'My gateway', modelId: 'claude-opus-5' });
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('records exactly the chosen mode', async () => {
    const { offer, writes } = await host(ROAM);
    await offer({ connectionName: 'My gateway', modelId: 'claude-opus-5' });
    expect(writes).toEqual([['spend.referencePriceMode', 'roam']]);
  });

  it('offers a reference only when its current catalog can price the exact model id', async () => {
    const cases: Array<[string, string[]]> = [
      ['deepseek-v4.1-flash', [TOKEN_ONLY, UNODE, ROAM]], // a row in both references
      [GATEWAY_ID, [TOKEN_ONLY, UNODE, ROAM]], // the alias both references declare for that row
      ['DEEPSEEK/DeepSeek-V4.1-Flash', [TOKEN_ONLY, UNODE, ROAM]], // the same alias in another case, as the lookup reads it
      ['deepseek-v3.2', [TOKEN_ONLY, UNODE]], // a row in the Unode reference only
    ];
    for (const [modelId, buttons] of cases) {
      const { spend, offer, dialogs } = await host(undefined);
      await offer({ connectionName: 'OpenRouter', modelId });
      expect(dialogs().map((dialog) => dialog.buttons), modelId).toEqual([buttons]);
      // The reference buttons are exactly the references the price lookup answers for.
      const catalogs = spend.references.catalogs();
      expect(buttons.slice(1), modelId).toEqual([
        ...(lookupCatalogModel(catalogs.unode!, modelId) ? [UNODE] : []),
        ...(lookupCatalogModel(catalogs.roam!, modelId) ? [ROAM] : []),
      ]);
    }
  });

  it('asks nothing when no reference can price the model, and keeps the weekly offer for one that can', async () => {
    // The mocked answer would record a mode if any of these opened the dialog.
    const { offer, dialogs, writes, state, logs } = await host(UNODE);
    const unpriced = ['deepseek/deepseek-v4-pro', `openrouter/${GATEWAY_ID}`, 'deepseek-v4.1', 'm1'];
    for (const modelId of unpriced) await offer({ connectionName: 'OpenRouter', modelId });
    expect(dialogs()).toEqual([]);
    expect(writes).toEqual([]);
    expect(state.size).toBe(0);
    expect(logs).toEqual(unpriced.map((modelId) => `[spend] No reference-price choice was offered for ${modelId}: neither the Unode nor the Roam reference has a price for it.`));
    await offer({ connectionName: 'OpenRouter', modelId: GATEWAY_ID });
    expect(dialogs().map((dialog) => dialog.buttons)).toEqual([[TOKEN_ONLY, UNODE, ROAM]]);
    expect(writes).toEqual([['spend.referencePriceMode', 'unode']]);
  });

  it('leaves out the button of a stale catalog that lacks the row, and keeps the one of a stale catalog that has it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-01T00:00:00.000Z'));
    const { spend, offer, dialogs } = await host(undefined);
    // Unode's current capture is a refreshed one that does not list the model. Both captures are stale by now.
    const listing: PriceFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(pricingBody({ 'claude-opus-5': 1 })) });
    await spend.references.refresh('unode', 'https://www.unodetech.xyz/api/pricing', listing, () => Date.parse('2026-10-01T00:00:00.000Z'));
    const catalogs = spend.references.catalogs();
    expect(catalogs.unode?.capturedAt).toBe('2026-10-01T00:00:00.000Z');
    expect([catalogIsStale(catalogs.unode!, Date.now()), catalogIsStale(catalogs.roam!, Date.now())]).toEqual([true, true]);
    await offer({ connectionName: 'OpenRouter', modelId: GATEWAY_ID });
    const [dialog] = dialogs();
    expect(dialog.buttons).toEqual([TOKEN_ONLY, ROAM]);
    expect(dialog.detail).toContain(' The Roam reference was captured 2026-09-27. The Unode reference has no price for this model, so it is not offered. ');
    // Token reminders only shows the Unode figure, and here there is none to show.
    expect(dialog.detail).toContain(' Token reminders only never uses an estimate for a dollar reminder. ');
    expect(dialog.detail).not.toContain('still shows the dated Unode estimate');
  });

  it('offers a capture refreshed before the alias was declared, since it answers to the alias once loaded', async () => {
    const { spend, storage, offer, dialogs } = await host(undefined);
    // An earlier version wrote this capture: it has the row, and no alias. It is newer than the bundled one.
    const earlier = catalogFromNewApiPricing(pricingBody({ 'deepseek-v4.1-flash': 1 }), {
      provider: 'unode', capturedAt: '2026-10-02T00:00:00.000Z', sourceUrl: 'https://www.unodetech.xyz/api/pricing',
    });
    const dir = path.join(storage, 'pricing', 'v1', 'unode');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${earlier.catalogId}.json`), JSON.stringify(earlier));
    await fsp.writeFile(path.join(dir, 'current.json'), JSON.stringify({ catalogId: earlier.catalogId }));
    await spend.references.load();
    expect(spend.references.catalogs().unode).toMatchObject({ catalogId: earlier.catalogId, capturedAt: earlier.capturedAt });
    await offer({ connectionName: 'OpenRouter', modelId: GATEWAY_ID });
    expect(dialogs().map((dialog) => dialog.buttons)).toEqual([[TOKEN_ONLY, UNODE, ROAM]]);
    expect(dialogs()[0].detail).toContain(' The Unode reference was captured 2026-10-02, the Roam reference 2026-09-27. ');
  });

  it('says the turn that just ended stays unpriced and the choice is for later turns', async () => {
    const { offer, dialogs } = await host(undefined);
    await offer({ connectionName: 'OpenRouter', modelId: GATEWAY_ID });
    const [dialog] = dialogs();
    expect(dialog.message).toBe('OpenRouter did not report a price for deepseek/deepseek-v4.1-flash, and no account price is set for this key. '
      + 'May dollar reminders use a dated estimate for later turns?');
    expect(dialog.detail).toBe('Your choice applies to turns that start after it. The turn that just ended stays unpriced for dollar reminders, '
      + 'and so does any turn already running: a turn keeps the price it started with. '
      + 'Tokens are always counted. The Unode reference was captured 2026-09-27, the Roam reference 2026-09-27. '
      + 'A reference is an estimate, not your bill. Token reminders only still shows the dated Unode estimate but never uses it for a dollar reminder. '
      + 'If this key pays a discounted rate, set its coefficient (unode.priceMultiplier) or group (unode.priceGroup) instead; an account price always wins. '
      + 'Change this any time in Settings → Spend.');
  });

  it('leaves the receipt of a turn that began before the choice as it was recorded', async () => {
    const { spend, show, writes, dialogs, events, receipts, begin, finish } = await host(undefined, { route: gateway });
    let answer: (choice: string) => void = () => undefined;
    show.mockImplementation((_message: string, options: unknown) => (options as { modal?: boolean } | undefined)?.modal === true
      ? new Promise<string>((resolve) => { answer = resolve; })
      : Promise.resolve(undefined));
    const unodeRate = lookupCatalogModel(spend.references.catalogs().unode!, GATEWAY_ID)!.rates.input;
    spend.coordinator.beginRequest('req1', 'pm');
    // The first turn ends without reminder dollars, which is what opens the choice.
    begin('finished', GATEWAY_ID);
    await finish('finished');
    await vi.waitFor(() => expect(dialogs()).toHaveLength(1));
    const asRecorded = JSON.parse(JSON.stringify(receipts()[0])) as unknown;
    // A second turn is already running when the choice is made.
    begin('running', GATEWAY_ID);
    answer(UNODE);
    await vi.waitFor(() => expect(writes).toEqual([['spend.referencePriceMode', 'unode']]));
    await finish('running');
    // A turn that starts after the choice is the first one the Unode estimate prices for a dollar reminder.
    begin('later', GATEWAY_ID);
    await finish('later');
    const byUnit = Object.fromEntries(receipts().map((receipt) => [receipt.usageUnitId, receipt]));
    expect(Object.keys(byUnit)).toEqual(['finished', 'running', 'later']);
    expect(byUnit.finished).toEqual(asRecorded);
    expect(byUnit.finished.reminderValue).toEqual({ tokens: 1_000_000, basis: 'reported-tokens' });
    expect(byUnit.running.reminderValue).toEqual({ tokens: 1_000_000, basis: 'reported-tokens' });
    expect(byUnit.later.reminderValue).toEqual({ tokens: 1_000_000, nanoUsd: unodeRate.toString(), basis: 'selected-reference' });
    // Nothing recorded afterwards reprices either earlier turn, and only the later turn adds reminder dollars.
    expect(events().map((event) => event.kind).filter((kind) => kind !== 'usage-unit-start')).toEqual(['usage-receipt', 'usage-receipt', 'usage-receipt']);
    expect(spend.coordinator.viewModel().requests[0].eligibleNanoUsd).toBe(unodeRate);
    expect(dialogs()).toHaveLength(1);
  });

  it('counts a turn no source can price in tokens only, never as zero dollars', async () => {
    for (const mode of ['unselected', 'unode', 'roam', 'token-only']) {
      // The mocked answer would record a mode if the choice opened for this unpriced model.
      const { spend, writes, dialogs, receipts, begin, finish, setMode } = await host(UNODE, { route: gateway });
      setMode(mode);
      spend.coordinator.beginRequest('req1', 'pm');
      begin('unpriced', 'deepseek/deepseek-v4-pro');
      const projection = await finish('unpriced');
      expect(projection, mode).toEqual({});
      const [receipt] = receipts();
      expect(receipt.displayCost, mode).toEqual({ basis: 'unavailable' });
      expect(receipt.reminderValue, mode).toEqual({ tokens: 1_000_000, basis: 'reported-tokens' });
      expect(JSON.stringify(receipt), mode).not.toContain('nanoUsd');
      expect(dialogs(), mode).toEqual([]);
      expect(writes, mode).toEqual([]);
    }
  });
});
