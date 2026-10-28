/*
 * v0.9.99 (B12): the extension's own handler for a change of the first workspace folder, run from the actual source of
 * extension.ts with the real binding. Before, it stopped every agent, Integration and terminal and refused later work
 * until a reload. Now running work continues in the folder UnodeAi started with, and a reload is offered, not forced.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { FirstWorkspaceBinding } from '../../backend/WorkspaceBinding';

const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
function folderChangeHandler(): string {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'vscode.workspace.onDidChangeWorkspaceFolders') found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(found).toHaveLength(1);
  return ts.transpileModule(`(${found[0].arguments[0].getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
    .outputText.trim().replace(/;$/, '');
}

function host(choice: string | undefined) {
  const first = path.resolve('workspace-one');
  let editorFirst = first;
  const workspaceBinding = new FirstWorkspaceBinding(first);
  const h = {
    workspaceBinding,
    editorFirstWorkspaceRoot: () => editorFirst,
    firstWorkspaceRoot: () => workspaceBinding.root(),
    outputChannel: { info: vi.fn(), warn: vi.fn() },
    vscode: {
      window: { showInformationMessage: vi.fn(async (..._args: unknown[]) => choice), showWarningMessage: vi.fn() },
      commands: { executeCommand: vi.fn(async () => undefined) },
    },
    sessionManager: { stopAll: vi.fn(), dispose: vi.fn() },
    mcpHub: { stopAll: vi.fn() },
    terminalManager: { disposeAll: vi.fn() },
    showWorkspaceBindingRequired: vi.fn(),
  };
  const handler = new Function('host', `with (host) { return ${folderChangeHandler()}; }`)(h) as () => void;
  return { h, first, handler, setEditorFirst: (root: string) => { editorFirst = root; } };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a change of the first workspace folder (v0.9.99)', () => {
  it('stops nothing, keeps the bound folder, and offers a non-modal reload once', async () => {
    const { h, first, handler, setEditorFirst } = host(undefined);
    setEditorFirst(path.resolve('workspace-two'));
    handler(); await flush();
    expect(h.sessionManager.stopAll).not.toHaveBeenCalled();
    expect(h.sessionManager.dispose).not.toHaveBeenCalled();
    expect(h.mcpHub.stopAll).not.toHaveBeenCalled();
    expect(h.terminalManager.disposeAll).not.toHaveBeenCalled();
    expect(h.showWorkspaceBindingRequired).not.toHaveBeenCalled();
    expect(h.workspaceBinding.root()).toBe(first);
    expect(h.vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    const [message, ...actions] = h.vscode.window.showInformationMessage.mock.calls[0];
    expect(message).toBe('The first workspace folder changed. UnodeAi keeps working in the folder it started with, so running work '
      + 'continues. Reload the window to switch UnodeAi to the new first folder.');
    expect(actions).toEqual(['Reload Window']); // no { modal: true }
    expect(h.vscode.commands.executeCommand).not.toHaveBeenCalled();
    // The same change reported again does not repeat the offer; the log line names no path.
    handler(); await flush();
    expect(h.vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.outputChannel.info.mock.calls)).not.toContain(first);
  });

  it('reloads only when the user chooses Reload Window', async () => {
    const { h, handler, setEditorFirst } = host('Reload Window');
    setEditorFirst(path.resolve('workspace-two'));
    handler(); await flush();
    expect(h.vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.reloadWindow');
  });

  it('an unchanged first folder does nothing', async () => {
    const { h, handler } = host(undefined);
    handler(); await flush();
    expect(h.vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });
});
