import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateWiring, extensionConstant, extensionWiring } from '../../views/__tests__/support/extensionWiring';
import { revealInOsLabel } from '../fileActions';

/*
 * v0.9.102: the extension's own runtime wiring of chat file navigation, run from src/extension.ts against a recorded
 * VS Code: how a checked file opens, how it is revealed, and the notification shown when the clicked surface is gone.
 */
function vscodeDouble(choice?: string) {
  return {
    Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) },
    commands: { executeCommand: vi.fn(async () => undefined) },
    env: { clipboard: { writeText: vi.fn(async () => undefined) } },
    window: { showWarningMessage: vi.fn(async () => choice) },
  };
}

function runtime(vscode: ReturnType<typeof vscodeDouble>, openRecordedFile = vi.fn(async () => undefined),
  exportFilePdfForPerson = vi.fn(async () => undefined)) {
  const scope = {
    vscode, openRecordedFile, exportFilePdfForPerson,
    COPY_REFERENCE_PATH: extensionConstant('COPY_REFERENCE_PATH'),
    // v0.9.108 (L1): the extension's own label, VS Code's words for this platform.
    REVEAL_IN_OS: revealInOsLabel(process.platform),
  };
  const wired = <T,>(name: string) => evaluateWiring<T>(extensionWiring('OrchestrationHostAdapter', 0, name), scope);
  return {
    openRecordedFile: wired<(path: string, position?: unknown) => Promise<void>>('openRecordedFile'),
    revealRecordedFile: wired<(path: string) => Promise<void>>('revealRecordedFile'),
    exportRecordedFilePdf: wired<(agentId: string, path: string) => Promise<unknown>>('exportRecordedFilePdf'),
    warnFileNavigation: wired<(message: string, reference: string, reveal?: () => Promise<void>) => void>('warnFileNavigation'),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('the extension wires chat file navigation to VS Code', () => {
  it('opens a checked file through the system-aware opener with only its path and line', async () => {
    const open = vi.fn(async () => undefined);
    await runtime(vscodeDouble(), open).openRecordedFile('C:\\Docs\\合同.pdf', { line: 3 });
    expect(open).toHaveBeenCalledExactlyOnceWith('C:\\Docs\\合同.pdf', { line: 3 });
  });

  it('reveals a checked file in the system file manager', async () => {
    const vscode = vscodeDouble();
    await runtime(vscode).revealRecordedFile('C:\\Docs\\setup.bin');
    expect(vscode.commands.executeCommand).toHaveBeenCalledExactlyOnceWith('revealFileInOS', { scheme: 'file', fsPath: 'C:\\Docs\\setup.bin' });
  });

  it('notifies with Copy reference path, and with Reveal first when the file opens neither in the editor nor in an app', async () => {
    const copy = vscodeDouble('Copy reference path');
    runtime(copy).warnFileNavigation('"gone.md" does not exist.', 'gone.md');
    await settle();
    expect(copy.window.showWarningMessage).toHaveBeenCalledExactlyOnceWith('"gone.md" does not exist.', 'Copy reference path');
    expect(copy.env.clipboard.writeText).toHaveBeenCalledExactlyOnceWith('gone.md');

    const reveal = vi.fn(async () => undefined);
    const label = revealInOsLabel(process.platform);
    const choose = vscodeDouble(label);
    runtime(choose).warnFileNavigation('VS Code did not open "setup.bin" in the editor.', 'setup.bin', reveal);
    await settle();
    expect(choose.window.showWarningMessage).toHaveBeenCalledExactlyOnceWith('VS Code did not open "setup.bin" in the editor.',
      label, 'Copy reference path');
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(choose.env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('v0.9.108 L1: the extension labels Reveal with its platform words and hands Export PDF to the person export', async () => {
    const source = readFileSync('src/extension.ts', 'utf8');
    expect(source).toMatch(/^const REVEAL_IN_OS = revealInOsLabel\(process\.platform\);$/m);
    const exported = vi.fn(async () => undefined);
    const report = path.join(os.tmpdir(), 'report.docx');
    await runtime(vscodeDouble(), undefined, exported).exportRecordedFilePdf('dev', report);
    expect(exported).toHaveBeenCalledExactlyOnceWith('dev', report);
  });
});
