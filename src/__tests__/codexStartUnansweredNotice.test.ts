/*
 * v0.9.104 D3.6 (ROADMAP item 16, the audit of d4d262ba): the "Codex has not answered at start" warning's Open Codex CLI
 * settings button was registered but never clicked by a test. The actual function from src/extension.ts (wired as the
 * Codex backend's onStartUnanswered) runs here with VS Code's two calls stood in.
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
  const node = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!node) throw new Error(`Missing actual ${name}`);
  return ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

function notifier(choice: string | undefined) {
  const vscode = {
    window: { showWarningMessage: vi.fn(async () => choice) },
    commands: { executeCommand: vi.fn(async () => undefined) },
  };
  const notify = new Function('vscode', `${declaration('notifyCodexStartUnanswered')}; return notifyCodexStartUnanswered;`)(vscode) as
    (agentName: string, seconds: number) => void;
  return { vscode, notify };
}

describe('the Codex start-unanswered warning (v0.9.104 D3.6)', () => {
  it('offers Open Codex CLI settings, and pressing it opens Settings at Providers', async () => {
    const { vscode, notify } = notifier('Open Codex CLI settings');
    notify('Codex Dev', 60);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringMatching(/^Codex Dev: Codex has not answered for 60 s, .*The start keeps waiting; press Stop to cancel\.$/),
      'Open Codex CLI settings');
    await vi.waitFor(() => expect(vscode.commands.executeCommand).toHaveBeenCalledWith('unode.openSettings', 'providers'));
  });

  it('opens nothing when the warning is dismissed', async () => {
    const { vscode, notify } = notifier(undefined);
    notify('Codex Dev', 60);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });
});
