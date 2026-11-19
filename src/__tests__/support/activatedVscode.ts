/*
 * The VS Code API stand-in of the activate() flows (moved from ActivatedExtension.flows.test.ts, unchanged). A test file
 * creates the host in vi.hoisted and builds the module in vi.mock('vscode'); this module imports nothing that imports
 * vscode, so it can be loaded before the mock is in place.
 */
import * as nodeFs from 'fs';
import * as nodePath from 'path';

export function createActivatedHost() {
  const overrides: Record<string, unknown> = {};
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const views = new Map<string, unknown>();
  const warnings: string[] = [];
  const infos: string[] = [];
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
  return { overrides, commands, views, warnings, infos, stub, root: '' };
}

export type ActivatedHost = ReturnType<typeof createActivatedHost>;

export function activatedVscodeModule(host: ActivatedHost): unknown {
  const root = host.stub('vscode') as Record<PropertyKey, unknown>;
  class EventEmitter<T> {
    private listeners: ((value: T) => void)[] = [];
    event = (listener: (value: T) => void) => { this.listeners.push(listener); return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } }; };
    fire(value: T) { for (const listener of [...this.listeners]) listener(value); }
    dispose() { this.listeners = []; }
  }
  class Disposable { constructor(private readonly done?: () => void) {} dispose() { this.done?.(); } static from() { return new Disposable(); } }
  const Uri = {
    file: (fsPath: string) => ({ fsPath, scheme: 'file', path: fsPath.replace(/\\/g, '/'), toString: () => `file://${fsPath}`, with: () => Uri.file(fsPath) }),
    joinPath: (uri: { fsPath: string }, ...parts: string[]) => Uri.file(nodePath.join(uri.fsPath, ...parts)),
    parse: (value: string) => Uri.file(value.replace(/^file:\/\//, '')),
  };
  const notFound = (error: unknown) => Object.assign(new Error(String(error)), { code: 'FileNotFound' });
  Object.assign(host.overrides, {
    'vscode.EventEmitter': EventEmitter, 'vscode.Disposable': Disposable, 'vscode.Uri': Uri,
    'vscode.FileType': { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    'vscode.QuickPickItemKind': { Separator: -1, Default: 0 },
    'vscode.ExtensionMode': { Production: 1, Development: 2, Test: 3 },
    'vscode.ConfigurationTarget': { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    'vscode.ViewColumn': { One: 1, Two: 2, Active: -1, Beside: -2 },
    'vscode.commands.registerCommand': (name: string, handler: (...args: unknown[]) => unknown) => {
      host.commands.set(name, handler); return new Disposable();
    },
    'vscode.window.registerWebviewViewProvider': (id: string, provider: unknown) => { host.views.set(id, provider); return new Disposable(); },
    'vscode.workspace.isTrusted': true,
    'vscode.env.appName': 'Visual Studio Code',
    // VS Code always gives a window a session id; the run ledger's owner of a delegation is that window. Without it,
    // every delegation still active at a 5 s ownership tick read as owner-less and was marked interrupted (the
    // v0.9.102 release chain: a result that never woke the PM, only when a slow machine let a tick land mid-task).
    'vscode.env.sessionId': 'activated-flows-window',
    'vscode.workspace.fs': {
      readFile: async (uri: { fsPath: string }) => { try { return nodeFs.readFileSync(uri.fsPath); } catch (e) { throw notFound(e); } },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        nodeFs.mkdirSync(nodePath.dirname(uri.fsPath), { recursive: true }); nodeFs.writeFileSync(uri.fsPath, bytes);
      },
      createDirectory: async (uri: { fsPath: string }) => { nodeFs.mkdirSync(uri.fsPath, { recursive: true }); },
      delete: async (uri: { fsPath: string }) => { nodeFs.rmSync(uri.fsPath, { recursive: true, force: true }); },
      stat: async (uri: { fsPath: string }) => {
        try { const s = nodeFs.statSync(uri.fsPath); return { type: s.isDirectory() ? 2 : 1, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs }; } catch (e) { throw notFound(e); }
      },
      readDirectory: async (uri: { fsPath: string }) => {
        try { return nodeFs.readdirSync(uri.fsPath, { withFileTypes: true }).map((d) => [d.name, d.isDirectory() ? 2 : 1]); } catch (e) { throw notFound(e); }
      },
    },
  });
  return new Proxy({}, { has: () => true, get: (_target, prop) => (prop === 'then' ? undefined : root[prop]) });
}
