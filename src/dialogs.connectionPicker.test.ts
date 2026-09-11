import { beforeEach, describe, expect, it, vi } from 'vitest';

// Simulated model QuickPick, shared with the hoisted vscode mock below. `nextModel === undefined` makes the
// picker resolve as a user cancel; otherwise it accepts that model. `count` records how many times the model
// picker was opened, so team creation can assert it prompts ONCE for the crew, not once per agent.
const qp = vi.hoisted(() => ({ nextModel: undefined as string | undefined, count: 0 }));

vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1 },
  ConfigurationTarget: { Workspace: 2 },
  workspace: {
    getConfiguration: () => ({ get: () => '', update: vi.fn() }),
    workspaceFolders: [{ uri: { fsPath: '/some/workspace' } }],
  },
  window: {
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
    createQuickPick: () => {
      qp.count++;
      const h: { accept?: () => void; hide?: () => void; change?: (v: string) => void } = {};
      const picker: any = {
        title: '', placeholder: '', ignoreFocusOut: false, matchOnDescription: false,
        items: [], value: '', busy: false, selectedItems: [] as any[], activeItems: [] as any[],
        onDidChangeValue: (cb: any) => { h.change = cb; return { dispose() {} }; },
        onDidAccept: (cb: any) => { h.accept = cb; return { dispose() {} }; },
        onDidHide: (cb: any) => { h.hide = cb; return { dispose() {} }; },
        show: () => {
          // The real picker resolves on user action; simulate it one microtask after it opens.
          queueMicrotask(() => {
            if (qp.nextModel === undefined) { h.hide?.(); }
            else { picker.selectedItems = [{ label: qp.nextModel }]; h.accept?.(); }
          });
        },
        hide: () => { h.hide?.(); },
        dispose: () => {},
      };
      return picker;
    },
  },
}));
vi.mock('./backend/CommandApprovalPrompter', () => ({ promptCommandApproval: vi.fn().mockResolvedValue(false) }));

import { createSoloAgent, createDefaultTeam } from './dialogs';
import { customGatewayResolver, CUSTOM_GATEWAY_ID } from './routes/__tests__/customGatewayFixture';
import type { ConnectionPick } from './dialogs';

function makeDeps(opts: { resolver?: any; provider?: string; captured?: ConnectionPick[]; pick?: (items: ConnectionPick[]) => ConnectionPick | undefined } = {}) {
  const created: any[] = [];
  const deps: any = {
    sessionManager: { getAll: () => [], create: (c: any) => { created.push(c); }, remove: async () => {} },
    secrets: { has: async () => true, get: async () => 'test-key', promptAndStore: async () => {} },
    output: { info: () => {}, warn: () => {} },
    commandPolicy: { approvalMode: 'none', reload: () => {} },
    defaultBackendKind: (c: any) => c.provider?.providerId === 'anthropic' ? 'claude' : 'openai-compat',
    defaultProvider: () => opts.provider ?? 'unode',
    connectionResolver: opts.resolver,
    modelCatalog: { list: async () => [] },
    ensureModelPickerConsent: async () => {},
    refreshPrices: () => {},
    pricing: undefined,
    chooseConnection: async (items: ConnectionPick[]) => {
      opts.captured?.push(...items);
      return opts.pick ? opts.pick(items) : items[0];
    },
  };
  return { deps, created };
}

const pickCustom = (items: ConnectionPick[]) => items.find((i) => i.connectionId === CUSTOM_GATEWAY_ID);
const pickUnode = (items: ConnectionPick[]) => items.find((i) => i.providerKey === 'unode');

beforeEach(() => { qp.count = 0; qp.nextModel = 'picked-model'; });

// ── K1 ────────────────────────────────────────────────────────────────────────────────────────────
// connectionPickItems mapped profile.id through legacyProviderIdForConnectionId WITHOUT the resolver, so it
// fell back to the built-in registry and dropped every custom:<id> profile — named gateways were absent from
// the Add Agent / Solo / team-preset picker. These fail if the picker resolves against the wrong registry.
describe('connection picker exposes named custom gateways (K1)', () => {
  it('lists a custom:<id> gateway with its display name, and the item round-trips to the custom connection id', async () => {
    const captured: ConnectionPick[] = [];
    const { deps } = makeDeps({ resolver: customGatewayResolver({ displayName: 'My Gateway' }), captured, pick: pickCustom });

    const cfg: any = await createSoloAgent(deps);

    const item = captured.find((i) => i.connectionId === CUSTOM_GATEWAY_ID);
    expect(item, 'custom gateway missing from picker').toBeDefined();
    expect(item?.providerKey).toBe(CUSTOM_GATEWAY_ID);
    expect(item?.label).toContain('My Gateway');
    expect(cfg?.provider.providerId).toBe(CUSTOM_GATEWAY_ID);
    expect(cfg?.route?.connectionId).toBe(CUSTOM_GATEWAY_ID);
    expect(cfg?.backend).toBe('openai-compat');
  });

  it('still offers the built-in gateways alongside the custom one', async () => {
    const captured: ConnectionPick[] = [];
    const { deps } = makeDeps({ resolver: customGatewayResolver({ displayName: 'My Gateway' }), captured, pick: pickCustom });
    await createSoloAgent(deps);

    expect(captured.find((i) => i.providerKey === 'unode')).toBeDefined();
    expect(captured.find((i) => i.providerKey === 'openrouter')).toBeDefined();
    expect(captured.find((i) => i.label.includes('Codex Headless'))).toBeUndefined();
  });

  it('shows no custom item when the resolver has no custom profiles (built-in registry unchanged)', async () => {
    const captured: ConnectionPick[] = [];
    const { deps } = makeDeps({ captured, pick: pickUnode });
    await createSoloAgent(deps);

    expect(captured.some((i) => i.connectionId.startsWith('custom:'))).toBe(false);
    expect(captured.find((i) => i.providerKey === 'unode')).toBeDefined();
  });
});

// ── K9 (release blocker) ──────────────────────────────────────────────────────────────────────────
// Custom profiles ship an empty catalog, so every preset role fell through to the template's Claude-tier id
// and 404'd on the first turn. Creation on a custom gateway must instead ask once for a model and apply it,
// and create nothing if the user cancels. Built-in gateways keep their per-role tier resolution untouched.
describe('team/solo creation never pins a Claude id on a custom gateway (K9)', () => {
  it('team on a custom gateway prompts exactly once and applies the chosen model to every agent', async () => {
    qp.nextModel = 'deepseek-v4-pro';
    const { deps, created } = makeDeps({ resolver: customGatewayResolver(), pick: pickCustom });

    const team = await createDefaultTeam(deps);

    expect(team.length).toBeGreaterThan(1);       // crew + the always-added solo
    expect(created.length).toBe(team.length);
    expect(qp.count).toBe(1);                      // ONE prompt for the whole crew, not one per agent
    for (const a of team) {
      expect(a.model).toBe('deepseek-v4-pro');
      expect(a.model).not.toMatch(/^claude-/);
      expect(a.provider.providerId).toBe(CUSTOM_GATEWAY_ID);
    }
  });

  it('team on a custom gateway creates nothing if the model prompt is cancelled', async () => {
    qp.nextModel = undefined; // user escapes the model picker
    const { deps, created } = makeDeps({ resolver: customGatewayResolver(), pick: pickCustom });

    const team = await createDefaultTeam(deps);

    expect(team).toEqual([]);
    expect(created).toEqual([]);
    expect(qp.count).toBe(1);
  });

  it('built-in gateway team is unaffected — no model prompt, provider-resolved models', async () => {
    const { deps, created } = makeDeps({ resolver: customGatewayResolver(), provider: 'unode', pick: pickUnode });

    const team = await createDefaultTeam(deps);

    expect(qp.count).toBe(0); // built-in teams never open the model picker
    expect(created.length).toBe(team.length);
    for (const a of team) {
      expect(a.provider.providerId).toBe('unode');
      expect(a.model).toBeTruthy();
    }
  });

  it('solo on a custom gateway prompts for a model and applies it', async () => {
    qp.nextModel = 'gwmodel-1';
    const { deps } = makeDeps({ resolver: customGatewayResolver(), pick: pickCustom });

    const solo: any = await createSoloAgent(deps);

    expect(qp.count).toBe(1);
    expect(solo?.model).toBe('gwmodel-1');
    expect(solo?.provider.providerId).toBe(CUSTOM_GATEWAY_ID);
  });

  it('solo on a custom gateway creates nothing if the model prompt is cancelled', async () => {
    qp.nextModel = undefined;
    const { deps, created } = makeDeps({ resolver: customGatewayResolver(), pick: pickCustom });

    const solo = await createSoloAgent(deps);

    expect(solo).toBeUndefined();
    expect(created).toEqual([]);
  });
});
