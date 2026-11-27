import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { ModelCatalog } from '../models/ModelCatalog';
import { describePurposes, planModelPicker, unapprovedHosts } from '../models/metadataPlan';

// Run the actual extension functions without activating VS Code or starting any CLI/model request.
const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
function extensionFunction(name: string, host: object): any {
  const declarations: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declarations.push(node); ts.forEachChild(node, visit); };
  visit(source); expect(declarations).toHaveLength(1);
  const code = ts.transpileModule(declarations[0].getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('host', `with (host) { ${code}; return ${name}; }`)(host);
}
function harness() {
  const approved = new Set<string>(); const declined = new Set<string>(); let answer: 'allow' | 'escape' = 'allow';
  const questions: any[] = []; const requests: string[] = [];
  const profiles = new Map(['a', 'b', 'claude', 'codex'].map(id => [id, { availability: 'available',
    catalogKind: id === 'claude' ? 'claude-cli' : id === 'codex' ? 'codex-cli' : 'openai-models', apiKeySecretName: id }]));
  const staticModels = (id: string) => [{ id: id + '-bundled', source: 'static' as const }];
  const catalog = new ModelCatalog(staticModels, async url => { requests.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'endpoint-model' }] }) };
  }, { userModels: id => [{ id: id + '-custom', source: 'user' }], canReadMetadata: url => approved.has(new URL(url).host) });
  const host: Record<string, any> = {
    effectiveConnectionRegistry: {}, connectionIdForProviderId: (id: string) => id,
    connectionProfile: (id: string) => profiles.get(id), staticCatalogModels: staticModels,
    resolveModelCatalogBaseUrl: (id: string) => `https://${id}.example/v1`,
    getModelCatalog: () => catalog, secrets: { get: async () => 'fixture-only-key' },
    agentBuilderModelOption: (value: any, price?: string) => ({ ...value, ...(price ? { price } : {}) }), modelPriceLabel: () => undefined,
    discoveredContextWindows: new Map(), contextWindowDiscoveryKey: (a: string, b: string) => a + b,
    configuredSetting: () => '', pricingSources: async () => [], refreshPrices: vi.fn(async () => {}),
    planModelPicker, unapprovedHosts, describePurposes,
    hasMetadataConsent: (name: string) => approved.has(name), declinedMetadataHosts: declined,
    consentGrants: { grant: (_kind: string, name: string) => { approved.add(name); return true; } },
    persistConsentGrants: vi.fn(async () => {}),
    vscode: { window: { showQuickPick: vi.fn(async (items: any[], options: any) => {
      questions.push({ items, options }); return answer === 'allow' ? items : undefined;
    }) } },
  };
  host.requestMetadataConsent = extensionFunction('requestMetadataConsent', host);
  host.ensureModelPickerConsent = extensionFunction('ensureModelPickerConsent', host);
  const list = extensionFunction('agentBuilderListModels', host);
  return { host, catalog, approved, questions, requests, list, answer: (value: 'allow' | 'escape') => { answer = value; } };
}

describe('v0.9.107 Agent Builder metadata intent', () => {
  it('opening uses only local/current cache; explicit connection selection keeps the original consent and selected-host request', async () => {
    const f = harness(); const current = () => true;
    expect((await f.list('a', undefined, 'Agent Builder model picker', { allowRemote: false, isCurrent: current })).map((m: any) => m.id)).toEqual(['a-custom', 'a-bundled']);
    expect(f.questions).toEqual([]); expect(f.requests).toEqual([]); expect(f.host.refreshPrices).not.toHaveBeenCalled();
    await f.list('b', undefined, 'Agent Builder model picker', { allowRemote: true, isCurrent: current });
    expect(f.questions).toHaveLength(1); expect(f.questions[0].items.map((item: any) => item.host)).toEqual(['b.example']);
    expect(f.questions[0].items.every((item: any) => item.picked === false)).toBe(true);
    expect(f.questions[0].options.title).toBe('Allow model metadata requests?');
    expect(f.questions[0].options.placeHolder).toContain('Press Escape to use built-in data instead.');
    expect(f.requests).toEqual(['https://b.example/v1/models']);
    const cached = await f.list('b', undefined, 'Agent Builder model picker', { allowRemote: false, isCurrent: current });
    expect(cached.map((m: any) => m.id)).toContain('endpoint-model'); expect(f.questions).toHaveLength(1); expect(f.requests).toHaveLength(1);
  });

  it('Escape and an existing decline keep bundled/custom models with no remote request or repeated question', async () => {
    const f = harness(); f.answer('escape');
    const options = { allowRemote: true, isCurrent: () => true };
    expect((await f.list('a', undefined, 'Agent Builder model picker', options)).map((m: any) => m.id)).toEqual(['a-custom', 'a-bundled']);
    await f.list('a', undefined, 'Agent Builder model picker', options);
    expect(f.questions).toHaveLength(1); expect(f.requests).toEqual([]); expect(f.approved.size).toBe(0);
  });

  it('leaving a connection during its prerequisite wait prevents a delayed metadata question', async () => {
    const f = harness(); let selected = true; let release!: () => void;
    f.host.pricingSources = () => new Promise(resolve => { release = () => resolve([]); });
    const pending = f.list('a', undefined, 'Agent Builder model picker', { allowRemote: true, isCurrent: () => selected });
    await vi.waitFor(() => expect(release).toBeTypeOf('function')); selected = false; release(); await pending;
    expect(f.questions).toEqual([]); expect(f.requests).toEqual([]); expect(f.host.refreshPrices).not.toHaveBeenCalled();
  });

  it('selecting CLI connections never asks for another connection’s metadata or starts discovery', async () => {
    const f = harness(); const options = { allowRemote: true, isCurrent: () => true };
    expect((await f.list('claude', undefined, 'Agent Builder model picker', options)).map((m: any) => m.id)).toEqual(['claude-custom', 'claude-bundled']);
    expect((await f.list('codex', undefined, 'Agent Builder model picker', options)).map((m: any) => m.id)).toEqual(['codex-bundled']);
    expect(f.questions).toEqual([]); expect(f.requests).toEqual([]);
  });

  it('retains reference prices on local Claude choices and leaves the Settings Smart picker on its existing path', async () => {
    const f = harness(); f.host.modelPriceLabel = () => '$fixture reference';
    const local = await f.list('claude', undefined, 'Agent Builder model picker', { allowRemote: true, isCurrent: () => true });
    expect(local.every((model: any) => model.price === '$fixture reference')).toBe(true);
    f.host.resolveModelCatalogBaseUrl = () => undefined;
    await f.list('claude', undefined, 'Settings Smart picker');
    expect(f.host.refreshPrices).toHaveBeenCalledWith({ scope: 'claude', trigger: 'Settings Smart picker' });
    expect(f.questions).toEqual([]); expect(f.requests).toEqual([]);
  });
});
