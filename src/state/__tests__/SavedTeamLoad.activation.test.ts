import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * v0.9.102 R3 (audit F1, F2): a saved team loaded through the extension's real entry. The extension module is imported
 * and its own activate() runs; the test then invokes the commands activate() registered, `unode.saveTeam` and
 * `unode.openSavedTeam` (the "Create/Save/Load a Team" picker), and reads the result the command returns (the live
 * roster) and the roster the extension persisted. Only the VS Code API is stood in: a generic stand-in that answers
 * every call, an in-memory file system, and scripted answers for the pickers and dialogs a person would answer.
 * Not a native VS Code host: no window, webview or real file system is involved.
 */
const host = vi.hoisted(() => {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const files = new Map<string, Uint8Array>();
  const overrides: Record<string, unknown> = {};
  function stub(path: string): unknown {
    const cache = new Map<PropertyKey, unknown>();
    return new Proxy(function () {} as object, {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        if (prop === Symbol.toPrimitive) return () => '';
        if (prop === Symbol.iterator) return function* () {};
        const key = `${path}.${String(prop)}`;
        if (key in overrides) return overrides[key];
        if (!cache.has(prop)) cache.set(prop, stub(key));
        return cache.get(prop);
      },
      // A configuration read answers its default; every other call answers another stand-in.
      apply(_target, _this, args) { return path.endsWith('.get') ? args[1] : stub(`${path}()`); },
      construct() { return stub(`new ${path}`) as object; },
    });
  }
  return { commands, files, overrides, stub };
});

vi.mock('vscode', () => {
  const root = host.stub('vscode') as Record<PropertyKey, unknown>;
  class EventEmitter<T> {
    private listeners: ((value: T) => void)[] = [];
    event = (listener: (value: T) => void) => { this.listeners.push(listener); return { dispose() {} }; };
    fire(value: T) { for (const listener of this.listeners) listener(value); }
    dispose() {}
  }
  class Disposable { constructor(private readonly done?: () => void) {} dispose() { this.done?.(); } static from() { return new Disposable(); } }
  const Uri = {
    file: (fsPath: string) => ({ fsPath, scheme: 'file', path: fsPath, toString: () => `file://${fsPath}` }),
    joinPath: (uri: { fsPath: string }, ...parts: string[]) => Uri.file([uri.fsPath, ...parts].join('/')),
    parse: (value: string) => Uri.file(value),
  };
  const missing = () => Object.assign(new Error('missing'), { code: 'FileNotFound' });
  Object.assign(host.overrides, {
    'vscode.EventEmitter': EventEmitter, 'vscode.Disposable': Disposable, 'vscode.Uri': Uri,
    // Enumerations the extension compares against keep their VS Code values.
    'vscode.FileType': { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    'vscode.QuickPickItemKind': { Separator: -1, Default: 0 },
    'vscode.ExtensionMode': { Production: 1, Development: 2, Test: 3 },
    'vscode.ConfigurationTarget': { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    'vscode.commands.registerCommand': (name: string, handler: (...args: unknown[]) => unknown) => {
      host.commands.set(name, handler); return new Disposable();
    },
    'vscode.workspace.workspaceFolders': [{ uri: Uri.file('/workspace'), name: 'workspace', index: 0 }],
    'vscode.workspace.isTrusted': true,
    'vscode.env.appName': 'Visual Studio Code',
    'vscode.workspace.fs': {
      readFile: async (uri: { fsPath: string }) => { const bytes = host.files.get(uri.fsPath); if (!bytes) throw missing(); return bytes; },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => { host.files.set(uri.fsPath, Buffer.from(bytes)); },
      createDirectory: async () => {},
      delete: async (uri: { fsPath: string }) => { host.files.delete(uri.fsPath); },
      stat: async (uri: { fsPath: string }) => { if (!host.files.has(uri.fsPath)) throw missing(); return { type: 1, size: host.files.get(uri.fsPath)!.length }; },
      readDirectory: async (uri: { fsPath: string }) => {
        const prefix = `${uri.fsPath}/`;
        const names = [...host.files.keys()].filter(k => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map(k => [k.slice(prefix.length), 1]);
        if (names.length === 0) throw missing();
        return names;
      },
    },
  });
  return new Proxy({}, { has: () => true, get: (_target, prop) => (prop === 'then' ? undefined : root[prop]) });
});

import * as vscode from 'vscode';
import type { AgentConfig } from '../../types';
import { PersistenceManager } from '../PersistenceManager';
import { RootScopedWorkspaceState } from '../RootScopedWorkspaceState';
import { AgentConfigBuilder } from '../../roles/RoleConfig';
import { defaultBackendKind } from '../../backend/backendKind';
import { BUILTIN_CONNECTION_REGISTRY } from '../../routes/ConnectionRegistry';

// These flow tests run real persistence, sessions, backends and commands, taking about 0.5-3 s each here and
// several times that on CI. The warm mutation worker keeps Vitest's 5 s default, so the suite's own 30 s budget
// (vitest.config.ts) is set here; CI 42814839194 judged two proofs invalid when a rerun ran past 5 s.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

function memento() {
  const values = new Map<string, unknown>();
  return { get: (key: string, fallback?: unknown) => (values.has(key) ? structuredClone(values.get(key)) : fallback),
    update: async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, structuredClone(value)); },
    keys: () => [...values.keys()], setKeysForSync() {} };
}
const context = {
  subscriptions: [] as { dispose(): void }[], globalState: memento(), workspaceState: memento(),
  extensionUri: { fsPath: process.cwd() }, extensionPath: process.cwd(), globalStorageUri: { fsPath: '/global' },
  storageUri: { fsPath: '/storage' }, logUri: { fsPath: '/log' }, extensionMode: 3, extension: { packageJSON: {} },
  secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
  asAbsolutePath: (value: string) => value, environmentVariableCollection: { replace() {}, clear() {} },
};

/** The persisted roster the next window starts from, read the way the extension stores it (activation-root scope). */
function persistedRoster(): AgentConfig[] {
  return new PersistenceManager(context as never, undefined, () => '/workspace', undefined, undefined,
    new RootScopedWorkspaceState(context.workspaceState as never, '/workspace')).loadAgents();
}

const notices: { kind: string; text: string }[] = [];
let reviewTicks: (title: string, items: readonly { detail?: string }[]) => readonly unknown[] | undefined = () => undefined;
let chooseTeam: (items: readonly { action?: string; ref?: { scope: string; slug: string } }[]) => unknown = () => undefined;

function quickPick() {
  const accepted: (() => void)[] = []; const hidden: (() => void)[] = [];
  const picker = {
    items: [] as { action?: string; ref?: { scope: string; slug: string } }[], selectedItems: [] as unknown[],
    title: '', placeholder: '', matchOnDescription: false, matchOnDetail: false, buttons: [],
    onDidAccept: (f: () => void) => { accepted.push(f); return { dispose() {} }; },
    onDidHide: (f: () => void) => { hidden.push(f); return { dispose() {} }; },
    onDidTriggerItemButton: () => ({ dispose() {} }), onDidChangeValue: () => ({ dispose() {} }),
    onDidChangeSelection: () => ({ dispose() {} }), onDidChangeActive: () => ({ dispose() {} }),
    show: () => { queueMicrotask(() => {
      const item = chooseTeam(picker.items);
      if (!item) { for (const f of hidden) f(); return; }
      picker.selectedItems = [item]; for (const f of accepted) f();
    }); },
    // VS Code reports the hide after the accept handler has returned.
    hide: () => { setTimeout(() => { for (const f of hidden) f(); }, 0); }, dispose() {},
  };
  return picker;
}

/** The person opens Create/Save/Load a Team and chooses one saved team. Returns the live roster the command returns. */
async function openSavedTeam(scope: 'workspace' | 'global', slug: string): Promise<AgentConfig[]> {
  chooseTeam = items => items.find(item => item.action === 'saved' && item.ref?.scope === scope && item.ref.slug === slug);
  const loaded = await host.commands.get('unode.openSavedTeam')!() as AgentConfig[] | undefined;
  expect(notices.filter(notice => notice.kind === 'error'), JSON.stringify(notices)).toEqual([]);
  return loaded ?? [];
}

function member(key: string, id: string, providerId = 'anthropic', patch: (config: AgentConfig) => void = () => {}): AgentConfig {
  const config = new AgentConfigBuilder().fromTemplate(key).setProviderById(providerId).setId(id).setName(id).build();
  config.backend = defaultBackendKind(config, BUILTIN_CONNECTION_REGISTRY);
  patch(config);
  return config;
}
const byId = (configs: readonly AgentConfig[]) => new Map(configs.map(config => [config.id, config]));

beforeAll(async () => {
  for (const [method, kind] of [['showInformationMessage', 'information'], ['showWarningMessage', 'warning'], ['showErrorMessage', 'error']] as const) {
    host.overrides[`vscode.window.${method}`] = vi.fn(async (text: string, ...rest: unknown[]) => {
      notices.push({ kind, text });
      // The Save-a-team scope question: This project.
      return rest.includes('Save to This project') ? 'Save to This project' : undefined;
    });
  }
  host.overrides['vscode.window.createQuickPick'] = quickPick;
  host.overrides['vscode.window.showQuickPick'] = vi.fn(async (items: readonly { detail?: string }[], options?: { title?: string }) =>
    reviewTicks(options?.title ?? '', await items));
  host.overrides['vscode.window.showInputBox'] = vi.fn(async () => 'Round trip');

  // A team an earlier session saved to This project through the extension's own writer, which records the
  // fingerprint. One Codex agent with Full access, one with Run commands Off, and one saved before command
  // choices were saved (its list has Write files but no Run commands).
  const seed = new PersistenceManager(context as never, undefined, () => '/workspace');
  await seed.saveTeamToLibrary({ scope: 'workspace', slug: 'crew' }, 'Crew', [
    member('senior-dev', 'codex', 'codex', config => { config.codexPermissionProfile = 'full-access'; }),
    member('tester', 'off', 'anthropic', config => {
      config.executePreference = 'deny'; config.allowedTools = config.allowedTools!.filter(tool => tool !== 'execute');
    }),
    member('business-analyst', 'old', 'anthropic', config => {
      delete config.executePreference; delete config.builtinToolDefaultsRevision; config.allowedTools = ['message', 'read', 'search', 'write'];
    }),
  ]);
  // The same bytes copied to another name: UnodeAi did not save this file there, so it is not recognised.
  host.files.set('/workspace/.unode/teams/copied.json', host.files.get('/workspace/.unode/teams/crew.json')!);

  const extension = await import('../../extension');
  await extension.activate(context as never);
  expect(host.commands.has('unode.openSavedTeam')).toBe(true);
  expect(host.commands.has('unode.saveTeam')).toBe(true);
}, 60_000);

describe('v0.9.102 R3: a saved team through the real Create/Save/Load a Team command (audit F1, F2)', () => {
  it('a recognised project save keeps Codex Full access, Run commands Off and an old agent\'s Run commands, live and stored, and again after Save', async () => {
    for (const slug of ['crew', 'round-trip']) {
      if (slug === 'round-trip') {
        // Save the loaded team again through the real Save command, to This project, and load that save.
        await host.commands.get('unode.saveTeam')!();
        expect(notices.some(notice => notice.text.includes('Saved "Round trip" to This project'))).toBe(true);
      }
      notices.length = 0;
      const live = byId(await openSavedTeam('workspace', slug));
      // Recognised: no unticked review opened.
      expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
      for (const [label, roster] of [['live', live], ['stored', byId(persistedRoster())]] as const) {
        expect([...roster.keys()].sort(), `${slug} ${label}`).toEqual(['codex', 'off', 'old']);
        expect(roster.get('codex'), `${slug} ${label}`).toMatchObject({ backend: 'codex', codexPermissionProfile: 'full-access', toolCeiling: 'bounded' });
        expect(roster.get('off')!.executePreference, `${slug} ${label}`).toBe('deny');
        expect(roster.get('off')!.allowedTools, `${slug} ${label}`).not.toContain('execute');
        // Saved before command choices existed: it follows its role's command default; a missing execute is not Off.
        expect(roster.get('old')!.executePreference, `${slug} ${label}`).toBe('template');
        expect([...roster.get('old')!.allowedTools!].sort(), `${slug} ${label}`).toEqual(['execute', 'message', 'read', 'search', 'write']);
      }
      expect(notices.some(notice => notice.text.includes('agent(s) restored'))).toBe(true);
      // The saved Codex choice is a declaration UnodeAi wrote itself, not an unknown setting to warn about.
      expect(notices.filter(notice => notice.text.includes('does not recognise'))).toEqual([]);
    }
  });

  it('an unrecognised copy never supplies Full access; ticking every offered capability keeps Off and keeps the Run commands an agent loaded with', async () => {
    notices.length = 0;
    const titles: string[] = [];
    // The unticked review opens for each agent; the person ticks everything it offers.
    reviewTicks = (title, items) => { titles.push(title); return items; };
    const live = byId(await openSavedTeam('workspace', 'copied'));
    expect(titles.length).toBeGreaterThan(0);
    for (const [label, roster] of [['live', live], ['stored', byId(persistedRoster())]] as const) {
      expect([...roster.keys()].sort(), label).toEqual(['codex', 'off', 'old']);
      expect(roster.get('codex'), label).toMatchObject({ backend: 'codex', codexPermissionProfile: 'approve-for-me', toolCeiling: 'bounded' });
      expect(roster.get('off')!.executePreference, label).toBe('deny');
      expect(roster.get('off')!.allowedTools, label).not.toContain('execute');
      expect(roster.get('old')!.executePreference, label).toBe('template');
      expect([...roster.get('old')!.allowedTools!].sort(), label).toEqual(['execute', 'message', 'read', 'search', 'write']);
    }
    expect(titles).toContain('Review permissions for codex');
    expect(titles).toContain('Review permissions for old');
  });
});

describe('Hardware Procurement through the registered team picker', () => {
  it('creates Hardware Procurement from system defaults and persists its specialists plus Solo', async () => {
    const priorWarning = host.overrides['vscode.window.showWarningMessage'];
    const priorQuickPick = host.overrides['vscode.window.showQuickPick'];
    const priorChooseTeam = chooseTeam;
    try {
      notices.length = 0;
      chooseTeam = items => items.find(item => item.action === 'preset'
        && 'preset' in item && (item.preset as { teamLabel?: string }).teamLabel === 'Hardware Procurement');
      host.overrides['vscode.window.showWarningMessage'] = vi.fn(async () => 'Add to current team');
      host.overrides['vscode.window.showQuickPick'] = vi.fn(async (items: readonly { providerKey?: string }[]) =>
        items.find(item => item.providerKey === 'unode'));

      const made = await host.commands.get('unode.createTeamPreset')!() as AgentConfig[] | undefined;
      const expected = ['pm', 'procurement-analyst', 'hardware-technical-analyst', 'financial-analyst', 'contract-analyst', 'solo'];
      expect(made?.map(agent => agent.roleTemplateKey)).toEqual(expected);
      expect(notices.filter(notice => notice.kind === 'error')).toEqual([]);
      const saved = byId(persistedRoster());
      for (const agent of made!) {
        expect(saved.get(agent.id)).toMatchObject({ roleTemplateKey: agent.roleTemplateKey, name: agent.name });
        expect(agent.workingDirectory).toBeUndefined();
      }
      const technical = made!.find(agent => agent.roleTemplateKey === 'hardware-technical-analyst')!;
      expect(technical.name).toBe('Hardware Technical Analyst');
      expect(technical.allowedTools).toEqual(expect.arrayContaining(['read', 'search', 'write', 'execute', 'message']));
      expect(technical.allowedTools).not.toContain('delegate');
      expect(technical.executePreference).toBe('template');
    } finally {
      host.overrides['vscode.window.showWarningMessage'] = priorWarning;
      host.overrides['vscode.window.showQuickPick'] = priorQuickPick;
      chooseTeam = priorChooseTeam;
    }
  });
});
