import { afterEach, expect, it, vi } from 'vitest';
const ui = vi.hoisted(() => ({ panels: [] as any[] }));
vi.mock('vscode', () => ({ QuickPickItemKind: { Separator: -1 }, ViewColumn: { Active: 1 },
  workspace: { getConfiguration: () => ({ get: () => '' }), workspaceFolders: [] }, window: {
    showInformationMessage: vi.fn(), showWarningMessage: vi.fn(),
    createWebviewPanel: () => {
      const panel: any = { dispose: () => panel.closed?.(), onDidDispose: (fn: unknown) => { panel.closed = fn; },
        webview: { cspSource: 'fixture:', html: '', postMessage: vi.fn(), onDidReceiveMessage: (fn: unknown) => { panel.receive = fn; } } };
      ui.panels.push(panel); return panel;
    },
  } }));
vi.mock('./backend/CommandApprovalPrompter', () => ({ promptCommandApproval: vi.fn().mockResolvedValue(false) }));

import { instantiateTeam, teamConnectionForm, createTeamFromPreset, teamActionItems, type DialogDeps } from './dialogs';
import { chooseTeamConnections } from './views/TeamConnectionsPanel';
import { bootWebviewScript, type WebviewElement } from './views/__tests__/support/webviewBoot';
import { customGatewayResolver, CUSTOM_GATEWAY_ID } from './routes/__tests__/customGatewayFixture';
import { parseTeamConnectionPlan } from './roles/TeamConnectionPlan';
import { MessageBus } from './bus/MessageBus';
import { SessionManager } from './session/SessionManager';
import { BUILTIN_CONNECTION_REGISTRY } from './routes/ConnectionRegistry';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); ui.panels.length = 0; });

function host() {
  const resolver = customGatewayResolver(); const bus = new MessageBus(); const backend = vi.fn(() => { throw Error('Configuration must not start a backend'); });
  const manager = new SessionManager(4, bus, { createBackend: backend, connectionResolver: () => resolver });
  cleanups.push(() => bus.dispose(), () => manager.stopAll());
  const network = { list: vi.fn(), consent: vi.fn(), prices: vi.fn(), secret: vi.fn() };
  const d = { sessionManager: manager, messageBus: bus, connectionResolver: resolver, defaultProvider: () => 'unode',
    defaultBackendKind: () => 'openai-compat', suppressInteractivePostCreatePrompts: true,
    output: { info() {} }, secrets: { has: vi.fn(), get: network.secret }, modelCatalog: { list: network.list },
    ensureModelPickerConsent: network.consent, refreshPrices: network.prices } as unknown as DialogDeps;
  return { d, manager, backend, network, resolver };
}

it('creates a genuinely mixed stopped roster through the real shared form script and full candidate validation, without discovery or starting a backend', async () => {
  const h = host(); const roles = ['pm', 'senior-dev', 'reviewer'] as const;
  const form = teamConnectionForm([...roles], 'unode', h.resolver);
  h.d.chooseTeamConnections = async () => {
    const selection = chooseTeamConnections(form, 'Create team', () => true); const panel = ui.panels.at(-1);
    const boot = bootWebviewScript(panel.webview.html);
    const rows = boot.elements.get('roles')!.children as WebviewElement[];
    const set = (index: number, connection: string, model: string) => {
      const fields = rows[index].children as WebviewElement[]; fields[1].value = connection; fields[2].value = model;
      boot.dispatchElementEvent(fields[1], 'change');
    };
    set(0, 'claude-cli', 'claude-review-fixture'); set(1, 'codex-cli', 'codex-work-fixture'); set(2, CUSTOM_GATEWAY_ID, 'gateway-review-fixture');
    boot.dispatchElementEvent(boot.elements.get('save')!, 'click'); panel.receive(boot.postedMessages.at(-1));
    return selection;
  };
  const members = await instantiateTeam(h.d, [...roles], 'Mixed crew');
  expect(members.map(member => [member.role, member.route?.connectionId, member.model])).toEqual([
    ['pm', 'claude-cli', 'claude-review-fixture'], ['senior-dev', 'codex-cli', 'codex-work-fixture'],
    ['reviewer', CUSTOM_GATEWAY_ID, 'gateway-review-fixture'], ['solo', 'unode', expect.any(String)],
  ]);
  expect(h.manager.getAll()).toHaveLength(4); expect(h.manager.getAll().every(session => session.status === 'stopped')).toBe(true);
  expect(h.backend).not.toHaveBeenCalled(); for (const spy of Object.values(h.network)) expect(spy).not.toHaveBeenCalled();
});

it('keeps the whole live roster unchanged when the last role choice is invalid or the shared editor is cancelled', async () => {
  const h = host(); const roles = ['pm', 'reviewer'] as const;
  await instantiateTeam(h.d, ['solo'], 'Existing Solo'); const existing = h.manager.getAll().map(session => session.config);
  h.d.roleConnections = [{ roleIndex: 2, roleKey: 'solo', connectionId: 'missing-connection', model: 'm' }];
  await expect(instantiateTeam(h.d, [...roles], 'Invalid crew')).rejects.toThrow('unavailable');
  expect(h.manager.getAll().map(session => session.config)).toEqual(existing); expect(h.backend).not.toHaveBeenCalled();
  delete h.d.roleConnections;
  h.d.chooseTeamConnections = async () => ({ connectionId: 'unode', roleConnections: [{ roleIndex: 2, roleKey: 'solo', connectionId: CUSTOM_GATEWAY_ID, model: 'chosen-before-removal' }] });
  h.d.currentConnectionResolver = () => BUILTIN_CONNECTION_REGISTRY;
  await expect(instantiateTeam(h.d, [...roles], 'Removed connection')).rejects.toThrow('unavailable');
  expect(h.manager.getAll().map(session => session.config)).toEqual(existing);
  delete h.d.currentConnectionResolver;
  h.d.chooseTeamConnections = async () => { const selection = chooseTeamConnections(teamConnectionForm([...roles], 'unode', h.resolver), 'Create team', () => true);
    ui.panels.at(-1).receive({ command: 'cancel' }); return selection; };
  expect(await instantiateTeam(h.d, [...roles], 'Cancelled crew')).toEqual([]); expect(h.manager.getAll().map(session => session.config)).toEqual(existing);
});

it('does not overwrite a newer typed role model when an earlier explicit Browse finishes later', async () => {
  const h = host(); const form = teamConnectionForm(['pm', 'reviewer'], 'unode', h.resolver);
  let answer!: (model: string) => void;
  const model = new Promise<string>(resolve => { answer = resolve; }); const picker = vi.fn(async () => model);
  const selection = chooseTeamConnections(form, 'Use these choices', () => true, picker); const panel = ui.panels.at(-1);
  const page = bootWebviewScript(panel.webview.html); const fields = ((page.elements.get('roles')!.children as WebviewElement[])[0].children as WebviewElement[]);
  fields[1].value = 'claude-cli'; page.dispatchElementEvent(fields[1], 'change');
  page.dispatchElementEvent(fields[3], 'click'); const waiting = panel.receive(page.postedMessages.at(-1));
  fields[2].value = 'newer-user-choice'; page.dispatchElementEvent(fields[2], 'input'); answer('older-model-list-choice'); await waiting;
  for (const [message] of panel.webview.postMessage.mock.calls) for (const listener of page.listeners.message ?? []) listener({ data: message });
  expect(fields[2].value).toBe('newer-user-choice'); expect(picker).toHaveBeenCalledExactlyOnceWith('claude-cli');
  await panel.receive({ command: 'cancel' }); expect(await selection).toBeUndefined(); expect(h.manager.getAll()).toEqual([]);
});

it('stages every role before the real preset replacement hook and keeps duplicate role positions distinct', async () => {
  const h = host(); const form = teamConnectionForm(['senior-dev', 'senior-dev'], 'unode', h.resolver);
  const plan = parseTeamConnectionPlan({ connectionId: 'unode', roleConnections: [
    { roleIndex: 0, roleKey: 'senior-dev', connectionId: 'claude-cli', model: 'first-model' },
    { roleIndex: 1, roleKey: 'senior-dev', connectionId: 'codex-cli', model: 'second-model' },
  ] }, form);
  h.d.chooseTeamConnections = async () => plan;
  const duplicate = await instantiateTeam(h.d, ['senior-dev', 'senior-dev'], 'Two developers');
  expect(duplicate.slice(0, 2).map(member => member.model)).toEqual(['first-model', 'second-model']);
  const replacement = host();
  replacement.d.chooseTeamConnections = async () => ({ connectionId: 'unode', roleConnections: [{ roleIndex: 0, roleKey: 'pm', connectionId: 'claude-cli', model: 'pm-model' }] });
  const replace = vi.fn(async () => true); replacement.d.replacePresetTeam = replace;
  const action = teamActionItems(0).find(item => 'action' in item && item.action === 'preset' && item.preset.roles[0] === 'pm')!;
  const members = await createTeamFromPreset(replacement.d, action as never);
  expect(replace).toHaveBeenCalledOnce(); expect(replace.mock.calls[0][0]).toMatchObject({ members });
  expect(replacement.manager.getAll()).toEqual([]); expect(members[0].route?.connectionId).toBe('claude-cli');
});
