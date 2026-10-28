import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function fixture(choice: string, fails = false) {
  const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'resetWorkspaceStateCommand');
  if (!fn) throw new Error('Missing actual reset command');
  const steps: string[] = [];
  const host = {
    vscode: { window: { showWarningMessage: vi.fn(async () => choice) }, commands: { executeCommand: vi.fn(async () => { steps.push('reload'); }) } },
    sessionManager: { getAll: () => [{ config: { id: 'worker' } }], remove: vi.fn(async () => { steps.push('remove'); }) },
    messageSaveTimer: undefined, runSaveTimer: undefined,
    chatDraftMirror: { retire: vi.fn(async () => { steps.push('retire'); }) },
    persistence: { resetWorkspaceState: vi.fn(async () => { steps.push('reset'); }), deleteTeamFile: vi.fn(async () => {
      steps.push('delete'); if (fails) throw new Error('private-error-canary');
    }) },
    effectiveConnectionRegistry: { profiles: [{ id: 'openai', apiKeySecretName: 'API_KEY' }, { id: 'custom:owned', apiKeySecretName: 'CUSTOM_KEY' }] },
    secrets: { delete: vi.fn(async () => { steps.push('key'); }) },
    outputChannel: { error: vi.fn() }, showResultNotice: vi.fn(async () => { steps.push('notice'); }),
  };
  const js = ts.transpileModule(fn.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const run: () => Promise<void> = new Function('host', `with (host) { ${js}; return resetWorkspaceStateCommand; }`)(host);
  return { host, steps, run };
}

describe('actual reset command partial-failure truth', () => {
  it('reports what was cleared and what was not; never reloads into an undeleted team or clears keys after refusal', async () => {
    const { host, steps, run } = fixture('Reset + clear API keys', true); await run();
    expect(steps).toEqual(['remove', 'retire', 'reset', 'delete', 'notice']);
    expect(host.showResultNotice).toHaveBeenCalledExactlyOnceWith('error', expect.stringContaining('API keys were not cleared and the window was not reloaded'));
    expect(host.showResultNotice.mock.calls[0].join(' ')).not.toContain('private-error-canary');
    expect(host.outputChannel.error).toHaveBeenCalledWith(expect.stringContaining('private-error-canary'));
    expect(host.vscode.commands.executeCommand).not.toHaveBeenCalled(); expect(host.secrets.delete).not.toHaveBeenCalled();
  });
  it('retains the successful reset/key/reload order and never deletes custom gateway keys', async () => {
    const { host, steps, run } = fixture('Reset + clear API keys'); await run();
    expect(steps).toEqual(['remove', 'retire', 'reset', 'delete', 'key', 'reload']);
    expect(host.secrets.delete).toHaveBeenCalledExactlyOnceWith('API_KEY'); expect(host.showResultNotice).not.toHaveBeenCalled();
  });
  it('does nothing when the real confirmation returns the non-consent choice', async () => {
    const { steps, run } = fixture('Keep current workspace', true); await run(); expect(steps).toEqual([]);
  });
});
