import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebviewPanel } from 'vscode';
import type { WorkflowConfig } from '../../types';
import { bootWebviewScript } from './support/webviewBoot';

const state = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  panel: undefined as any,
  onMessage: undefined as ((message: unknown) => Promise<void>) | undefined,
  onDispose: undefined as (() => void) | undefined,
}));

vi.mock('vscode', () => ({
  Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }), joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }) },
  ViewColumn: { One: 1 },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    fs: {
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const bytes = state.files.get(uri.fsPath);
        if (!bytes) throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
        return bytes;
      }),
      createDirectory: vi.fn(async () => {}),
      writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => { state.files.set(uri.fsPath, bytes); }),
    },
  },
  window: {
    showWarningMessage: vi.fn(),
    createWebviewPanel: vi.fn(() => {
      state.panel = {
        webview: {
          cspSource: 'test:', html: '', postMessage: vi.fn(async () => true),
          onDidReceiveMessage: (callback: typeof state.onMessage) => {
            state.onMessage = callback; return { dispose() {} };
          },
        },
        reveal: vi.fn(),
        onDidDispose: (callback: typeof state.onDispose) => {
          state.onDispose = callback; return { dispose() {} };
        },
      };
      return state.panel;
    }),
  },
}));

import * as vscode from 'vscode';
import { WorkflowEditor } from '../WorkflowEditor';
import { WorkflowEngine } from '../../workflow/WorkflowEngine';
import { PersistenceManager } from '../../state/PersistenceManager';
import { MessageBus } from '../../bus/MessageBus';
import type { SessionManager } from '../../session/SessionManager';
import { TeamVerificationConfigurationError } from '../../state/TeamFileSchema';

const TEAM = '/workspace/.unode/team.json';
const workflow: WorkflowConfig = { id: 'retained', name: 'Retained workflow', steps: [] };
const valid = () => Buffer.from(JSON.stringify({ version: '1.0', members: [], mcpServers: [], workflows: [workflow] }));
const invalid = () => Buffer.from(JSON.stringify({
  members: [], workflows: [workflow], completionVerification: { mode: 'Auto', command: '<secret>\nprivate' },
}));

function openEditor() {
  const persistence = new PersistenceManager({ workspaceState: {
    get: (_key: string, fallback: unknown) => fallback, update: async () => {}, keys: () => [],
  } } as never);
  // Real authoring engine and strict persistence reader, not an always-throwing list stub.
  const engine = new WorkflowEngine({} as SessionManager, new MessageBus(), undefined, undefined, persistence);
  const deps = {
    listWorkflows: vi.fn(() => engine.listWorkflows()), listAgents: () => [],
    saveWorkflow: vi.fn((value: WorkflowConfig) => engine.saveWorkflow(value)),
    deleteWorkflow: vi.fn((id: string) => engine.deleteWorkflow(id)),
  };
  WorkflowEditor.createOrShow({} as never, deps);
  return { deps, panel: state.panel as WebviewPanel, send: (message: unknown) => state.onMessage!(message) };
}

beforeEach(() => { state.files.clear(); vi.clearAllMocks(); });
afterEach(() => { state.onDispose?.(); state.onDispose = undefined; state.onMessage = undefined; });

describe('T1b MN1: persistent workflow editor configuration error', () => {
  it('reports invalid completionVerification on every refresh/reveal instead of posting an empty list', async () => {
    const original = invalid(); state.files.set(TEAM, original);
    const { deps, panel, send } = openEditor();
    await expect(send({ command: 'requestWorkflows' })).resolves.toBeUndefined();
    await send({ command: 'requestWorkflows' });
    WorkflowEditor.createOrShow({} as never, deps);
    await vi.waitFor(() => expect(panel.webview.postMessage).toHaveBeenCalledTimes(3));

    for (const [message] of vi.mocked(panel.webview.postMessage).mock.calls) {
      expect(message).toMatchObject({ command: 'workflowLoadError', message: expect.stringContaining('completionVerification') });
      expect(message.message).toContain('.unode/team.json');
      expect(message.message).toContain('Refresh');
      expect(message.message).not.toMatch(/private|secret/);
    }
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(state.files.get(TEAM)).toEqual(original);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('rereads before stale/forged save and delete requests and preserves the invalid original file', async () => {
    state.files.set(TEAM, valid());
    const { deps, panel, send } = openEditor();
    await send({ command: 'requestWorkflows' });
    expect(panel.webview.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      command: 'workflowData', custom: [expect.objectContaining({ id: workflow.id })],
    }));
    const original = invalid(); state.files.set(TEAM, original);
    await send({ command: 'saveWorkflow', workflow: { ...workflow, name: 'Overwrite' } });
    await send({ command: 'deleteWorkflow', id: workflow.id });
    expect(deps.saveWorkflow).not.toHaveBeenCalled();
    expect(deps.deleteWorkflow).not.toHaveBeenCalled();
    expect(panel.webview.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'workflowLoadError' }));
    expect(state.files.get(TEAM)).toEqual(original);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('recovers only after a successful reread, and then saves through the existing strict store', async () => {
    state.files.set(TEAM, invalid());
    const { panel, send } = openEditor();
    await send({ command: 'requestWorkflows' });
    state.files.set(TEAM, valid());
    await send({ command: 'requestWorkflows' });
    expect(panel.webview.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'workflowData' }));
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    await send({ command: 'saveWorkflow', workflow: { ...workflow, name: 'User repair confirmed' } });
    expect(JSON.parse(Buffer.from(state.files.get(TEAM)!).toString()).workflows[0].name).toBe('User repair confirmed');
  });

  it.each(['save', 'delete'] as const)('surfaces a strict %s failure occurring after the read without an unhandled rejection', async operation => {
    state.files.set(TEAM, valid());
    const { deps, panel, send } = openEditor();
    if (operation === 'save') deps.saveWorkflow.mockRejectedValueOnce(new TeamVerificationConfigurationError());
    else deps.deleteWorkflow.mockRejectedValueOnce(new TeamVerificationConfigurationError());
    await expect(send(operation === 'save'
      ? { command: 'saveWorkflow', workflow } : { command: 'deleteWorkflow', id: workflow.id })).resolves.toBeUndefined();
    expect(panel.webview.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      command: 'workflowLoadError', message: expect.stringContaining('completionVerification'),
    }));
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('does not echo arbitrary loader errors into a local banner or mistake them for an empty team', async () => {
    const { deps, panel, send } = openEditor();
    deps.listWorkflows.mockRejectedValueOnce(new Error('<img src=x onerror=secret()> private command'));
    await expect(send({ command: 'requestWorkflows' })).resolves.toBeUndefined();
    expect(panel.webview.postMessage).toHaveBeenCalledTimes(1);
    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      command: 'workflowLoadError', message: expect.not.stringMatching(/private|secret|<img/),
    });
  });

  it('does not let an older successful read clear a newer configuration error', async () => {
    state.files.set(TEAM, invalid());
    const { deps, panel, send } = openEditor();
    let resolveOld!: (value: Awaited<ReturnType<typeof deps.listWorkflows>>) => void;
    deps.listWorkflows.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    const oldRequest = send({ command: 'requestWorkflows' });
    await send({ command: 'requestWorkflows' });
    resolveOld([]); await oldRequest;
    expect(panel.webview.postMessage).toHaveBeenCalledTimes(1);
    expect(panel.webview.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'workflowLoadError' }));
  });

  it('does not let an older failed read cover newer successfully loaded workflows (MN3)', async () => {
    state.files.set(TEAM, valid());
    const { deps, panel, send } = openEditor();
    let rejectOld!: (error: unknown) => void;
    deps.listWorkflows.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectOld = reject; }));
    const oldRequest = send({ command: 'requestWorkflows' });
    await send({ command: 'requestWorkflows' });
    rejectOld(new TeamVerificationConfigurationError()); await oldRequest;
    expect(panel.webview.postMessage).toHaveBeenCalledTimes(1);
    expect(panel.webview.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      command: 'workflowData', custom: [expect.objectContaining({ id: workflow.id })],
    }));
  });

  it.each(['save', 'delete'] as const)('explains a %s superseded by a refresh, without calling a writer', async operation => {
    const original = valid(); state.files.set(TEAM, original);
    const { deps, panel, send } = openEditor();
    let resolveOld!: (value: Awaited<ReturnType<typeof deps.listWorkflows>>) => void;
    deps.listWorkflows.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    const write = send(operation === 'save'
      ? { command: 'saveWorkflow', workflow } : { command: 'deleteWorkflow', id: workflow.id });
    await send({ command: 'requestWorkflows' });
    resolveOld([]); await write;
    expect(deps.saveWorkflow).not.toHaveBeenCalled(); expect(deps.deleteWorkflow).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(state.files.get(TEAM)).toEqual(original);
    expect(panel.webview.postMessage).toHaveBeenLastCalledWith({ command: 'error', message: expect.stringContaining(
      operation === 'save' ? 'Save again' : 'Delete again',
    ) });
    const booted = bootWebviewScript(panel.webview.html);
    booted.listeners.message[0]({ data: vi.mocked(panel.webview.postMessage).mock.calls.at(-1)![0] });
    expect(booted.elements.get('status')!.textContent).toContain(operation === 'save' ? 'Save again' : 'Delete again');
  });

  it('does not post an error or write after disposal while a save reread is pending', async () => {
    const { deps, panel, send } = openEditor();
    let rejectOld!: (error: unknown) => void;
    deps.listWorkflows.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectOld = reject; }));
    const write = send({ command: 'saveWorkflow', workflow });
    state.onDispose!();
    rejectOld(new TeamVerificationConfigurationError()); await write;
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
    expect(deps.saveWorkflow).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('does not save if a newer refresh starts while the read response is being delivered', async () => {
    state.files.set(TEAM, valid());
    const { deps, panel, send } = openEditor();
    let deliverOld!: (value: boolean) => void;
    vi.mocked(panel.webview.postMessage).mockImplementationOnce(() => new Promise(resolve => { deliverOld = resolve; }));
    const write = send({ command: 'saveWorkflow', workflow });
    await vi.waitFor(() => expect(panel.webview.postMessage).toHaveBeenCalledTimes(1));
    await send({ command: 'requestWorkflows' });
    deliverOld(true); await write;
    expect(deps.saveWorkflow).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(panel.webview.postMessage).toHaveBeenLastCalledWith({ command: 'error', message: expect.stringContaining('Save again') });
  });

  it('does not post a deletion failure after the editor closes while the writer is pending (MN4)', async () => {
    state.files.set(TEAM, valid());
    const { deps, panel, send } = openEditor();
    let rejectDelete!: (error: unknown) => void;
    deps.deleteWorkflow.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectDelete = reject; }));
    const deletion = send({ command: 'deleteWorkflow', id: workflow.id });
    await vi.waitFor(() => expect(deps.deleteWorkflow).toHaveBeenCalledTimes(1));
    vi.mocked(panel.webview.postMessage).mockClear();
    state.onDispose!();
    // A real disposed webview rejects; any attempted post would escape as an unhandled error.
    vi.mocked(panel.webview.postMessage).mockRejectedValue(new Error('webview disposed'));
    rejectDelete(new TeamVerificationConfigurationError());
    await expect(deletion).resolves.toBeUndefined();
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('renders a persistent text-only alert, disables writes, and clears it only on successful data', () => {
    const { panel } = openEditor();
    expect(panel.webview.html).toContain('id="loadError" class="status error" role="alert" hidden');
    const booted = bootWebviewScript(panel.webview.html);
    const deliver = (data: unknown) => booted.listeners.message[0]({ data });
    const save = booted.listeners.click.find(fn => fn.name === 'saveWorkflow')!;
    const remove = booted.listeners.click.find(fn => fn.name === 'deleteCurrentWorkflow')!;
    const refresh = booted.listeners.click.find(fn => fn.name === 'refreshWorkflows')!;
    const error = booted.elements.get('loadError')!;
    expect(booted.elements.get('save')!.disabled).toBe(true);
    deliver({ command: 'workflowData', builtins: [], custom: [workflow], agents: [] });
    expect(booted.elements.get('save')!.disabled).toBe(false);
    deliver({ command: 'workflowLoadError', message: '<b>completionVerification</b> in .unode/team.json' });
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('<b>completionVerification</b> in .unode/team.json');
    expect(error.innerHTML).toBe('');
    expect(booted.elements.get('save')!.disabled).toBe(true);
    expect(booted.elements.get('deleteWorkflow')!.disabled).toBe(true);
    const posted = booted.postedMessages.length;
    save(); remove();
    expect(booted.postedMessages).toHaveLength(posted);
    deliver({ command: 'saved' }); deliver({ command: 'error', message: 'Some other status' }); refresh();
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('completionVerification');
    expect(booted.postedMessages.at(-1)).toEqual({ command: 'requestWorkflows' });
    deliver({ command: 'workflowData', builtins: [], custom: [workflow], agents: [] });
    expect(error.hidden).toBe(true);
    expect(error.textContent).toBe('');
    expect(booted.elements.get('save')!.disabled).toBe(false);
    save(); remove();
    expect(booted.postedMessages.slice(-2)).toEqual([
      expect.objectContaining({ command: 'saveWorkflow' }), { command: 'deleteWorkflow', id: workflow.id },
    ]);
  });
});
