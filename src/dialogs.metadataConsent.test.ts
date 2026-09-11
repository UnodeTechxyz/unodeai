import { describe, expect, it, vi } from 'vitest';
import { ModelCatalog } from './models/ModelCatalog';
import { consentGatedFetch } from './models/LivePriceService';
import type { DialogDeps } from './dialogs';

const vscodeMock = vi.hoisted(() => ({
  latestQuickPick: undefined as any,
}));

vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1 },
  ConfigurationTarget: { Workspace: 2 },
  workspace: {
    getConfiguration: () => ({ get: () => '', update: vi.fn() }),
    workspaceFolders: [{ uri: { fsPath: '/some/workspace' } }],
  },
  window: {
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    createQuickPick: () => {
      let onAccept: (() => void) | undefined;
      let onHide: (() => void) | undefined;
      const quickPick: any = {
        value: '',
        items: [],
        activeItems: [],
        selectedItems: [],
        busy: false,
        show: vi.fn(),
        hide: vi.fn(() => onHide?.()),
        dispose: vi.fn(),
        onDidChangeValue: vi.fn(() => ({ dispose: vi.fn() })),
        onDidAccept: vi.fn((listener: () => void) => {
          onAccept = listener;
          return { dispose: vi.fn() };
        }),
        onDidHide: vi.fn((listener: () => void) => {
          onHide = listener;
          return { dispose: vi.fn() };
        }),
        accept: () => onAccept?.(),
      };
      vscodeMock.latestQuickPick = quickPick;
      return quickPick;
    },
  },
}));

vi.mock('./backend/CommandApprovalPrompter', () => ({ promptCommandApproval: vi.fn().mockResolvedValue(false) }));

import { pickModel } from './dialogs';

function deps(overrides: Partial<DialogDeps> = {}): DialogDeps {
  return {
    pricing: { priceInfoFor: () => undefined },
    output: { warn: vi.fn() },
    ensureModelPickerConsent: vi.fn().mockResolvedValue(undefined),
    refreshPrices: vi.fn(),
    modelCatalog: { list: vi.fn().mockResolvedValue([{ id: 'static-model', source: 'static' }]) },
    ...overrides,
  } as unknown as DialogDeps;
}

describe('Add-Agent model picker metadata consent', () => {
  it('asks once before its scoped price refresh and model list request', async () => {
    const order: string[] = [];
    const d = deps({
      ensureModelPickerConsent: vi.fn(async (providerId: string, baseUrl?: string) => {
        order.push(`consent:${providerId}:${baseUrl}`);
      }),
      refreshPrices: vi.fn((opts) => { order.push(`refresh:${opts?.scope}`); }),
      modelCatalog: {
        list: vi.fn(async () => {
          order.push('models');
          return [{ id: 'static-model', source: 'static' }];
        }),
      } as any,
    });

    const picked = pickModel(d, 'roam', 'static-model', 'https://gateway.example/v1');
    await vi.waitFor(() => expect(order).toEqual([
      'consent:roam:https://ai.weroam.xyz/v1',
      'refresh:roam',
      'models',
    ]));
    expect(d.refreshPrices).toHaveBeenCalledWith({ scope: 'roam' });

    vscodeMock.latestQuickPick.hide();
    await expect(picked).resolves.toBeUndefined();
  });

  it('decline leaves the consent gate closed: static models remain usable and the inner fetch is never called', async () => {
    const innerFetch = vi.fn();
    const catalog = new ModelCatalog(
      () => [{ id: 'offline-model', source: 'static' }],
      consentGatedFetch(innerFetch as any, () => false),
    );
    const d = deps({
      // This mirrors a user declining the prompt: no host is added to the metadata-consent store.
      ensureModelPickerConsent: vi.fn().mockResolvedValue(undefined),
      modelCatalog: catalog,
    });

    const picked = pickModel(d, 'roam', 'offline-model', 'https://gateway.example/v1');
    await vi.waitFor(() => expect(vscodeMock.latestQuickPick.items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ label: 'offline-model' })])));
    expect(innerFetch).not.toHaveBeenCalled();

    vscodeMock.latestQuickPick.selectedItems = [{ label: 'offline-model' }];
    vscodeMock.latestQuickPick.accept();
    await expect(picked).resolves.toEqual({ id: 'offline-model', measuredContextWindow: undefined });
  });

  it('carries a window from the consented matching model row without another request', async () => {
    const list = vi.fn().mockResolvedValue([{
      id: 'gateway-model',
      source: 'endpoint',
      measuredContextWindow: { model: 'gateway-model', tokens: 128_000, field: 'context_length' },
    }]);
    const d = deps({ modelCatalog: { list } as any });
    const picked = pickModel(d, 'roam', 'gateway-model', 'https://gateway.example/v1');
    await vi.waitFor(() => expect(vscodeMock.latestQuickPick.items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ label: 'gateway-model' })])));

    vscodeMock.latestQuickPick.selectedItems = [{ label: 'gateway-model' }];
    vscodeMock.latestQuickPick.accept();
    await expect(picked).resolves.toEqual({
      id: 'gateway-model',
      measuredContextWindow: { model: 'gateway-model', tokens: 128_000, field: 'context_length' },
    });
    expect(list).toHaveBeenCalledTimes(1);
  });
});
