import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ openExternal: vi.fn(), openTextDocument: vi.fn(), showTextDocument: vi.fn(),
  showWarningMessage: vi.fn(), executeCommand: vi.fn() }));
vi.mock('vscode', () => ({
  Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) },
  env: { openExternal: mocks.openExternal }, workspace: { openTextDocument: mocks.openTextDocument },
  window: { showTextDocument: mocks.showTextDocument, showWarningMessage: mocks.showWarningMessage },
  commands: { executeCommand: mocks.executeCommand },
  Position: class { constructor(public line: number, public character: number) {} },
  Range: class { constructor(public start: unknown, public end: unknown) {} },
}));
import { openRecordedFile, type SystemDocumentOpening } from '../openRecordedFile';
import { FileNotOpenedAsText } from '../fileNotOpenedAsText';

function system(platform: NodeJS.Platform, systemRoot: string | undefined = 'C:\\Windows'): SystemDocumentOpening & { start: ReturnType<typeof vi.fn> } {
  return { platform, systemRoot, start: vi.fn(async () => {}) };
}

beforeEach(() => { vi.resetAllMocks(); mocks.openExternal.mockResolvedValue(true); });
describe('recorded file opening after path admission', () => {
  // v0.9.102: the field file of the report, "WorkingDocuments/Goodvision与MetaBlox_B300合同主要差异对比.pdf". Windows read
  // the file URL openExternal gave it byte by byte and answered 0x2; File Explorer is given the path itself.
  it.each(['.docx', '.xlsx', '.pptx', '.pdf', '.PDF'])('opens %s on Windows through File Explorer with the path as one argument, never a file URL', async extension => {
    const windows = system('win32');
    const file = `C:\\Work Docs\\WorkingDocuments\\Goodvision与MetaBlox_B300合同主要差异对比${extension}`;
    await openRecordedFile(file, { line: 9 }, windows);
    expect(windows.start).toHaveBeenCalledExactlyOnceWith({ command: 'C:\\Windows\\explorer.exe', args: [`"${file}"`], verbatim: true });
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.openTextDocument).not.toHaveBeenCalled();
    expect(mocks.showTextDocument).not.toHaveBeenCalled();
  });
  it.each(['darwin', 'linux'] as const)('keeps the system app through VS Code on %s, where a file URL names the file', async platform => {
    const other = system(platform, undefined);
    await openRecordedFile('/work/合同.docx', undefined, other);
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith({ scheme: 'file', fsPath: '/work/合同.docx' });
    expect(other.start).not.toHaveBeenCalled();
    mocks.openExternal.mockResolvedValue(false);
    await expect(openRecordedFile('/work/report.pdf', undefined, other)).rejects.toThrow('system could not open');
  });
  it('reports a File Explorer that cannot start, and finds it under the Windows folder without SystemRoot', async () => {
    const windows = system('win32', undefined);
    windows.start.mockRejectedValue(new Error('spawn C:\\Windows\\explorer.exe ENOENT'));
    await expect(openRecordedFile('D:\\合同.pdf', undefined, windows)).rejects.toThrow('ENOENT');
    expect(windows.start).toHaveBeenCalledWith({ command: 'C:\\Windows\\explorer.exe', args: ['"D:\\合同.pdf"'], verbatim: true });
  });
  it('keeps text navigation and validates the requested line and column', async () => {
    const at = { line: 2, character: 1 }; const validatePosition = vi.fn(() => at);
    const document = { validatePosition }; mocks.openTextDocument.mockResolvedValue(document);
    const windows = system('win32');
    await openRecordedFile('C:/workspace/source.ts', { line: 3, column: 2 }, windows);
    expect(validatePosition).toHaveBeenCalledWith(at);
    expect(mocks.showTextDocument).toHaveBeenCalledWith(document, { preview: false, selection: { start: at, end: at } });
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(windows.start).not.toHaveBeenCalled();
  });
  it.each(['.exe', '.msi', '.scr', '.com', '.cpl', '.lnk', '.bin', '.docx.exe'])('never launches %s: it fails as text with VS Code\'s reason and shows nothing itself', async extension => {
    mocks.openTextDocument.mockRejectedValue(new Error('cannot open file:///c%3A/workspace/data. Detail: File seems to be binary and cannot be opened as text'));
    const windows = system('win32');
    const failure = openRecordedFile(`C:/workspace/data${extension}`, undefined, windows);
    await expect(failure).rejects.toBeInstanceOf(FileNotOpenedAsText);
    await expect(failure).rejects.toThrow(
      `VS Code did not open "data${extension}" in the editor: File seems to be binary and cannot be opened as text. `
      + 'UnodeAi opens Word, Excel, PowerPoint and PDF files in their app, and other files in the editor. '
      + 'To open this one, reveal it in File Explorer and open it there.');
    expect(windows.start).not.toHaveBeenCalled(); expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.showTextDocument).not.toHaveBeenCalled();
    expect(mocks.showWarningMessage).not.toHaveBeenCalled(); expect(mocks.executeCommand).not.toHaveBeenCalled();
  });
  it('keeps a localized or other editor reason as VS Code gave it, on one bounded line', async () => {
    mocks.openTextDocument.mockRejectedValueOnce(new Error('文件为二进制，无法作为文本打开。'));
    await expect(openRecordedFile('C:/workspace/安装包.exe', undefined, system('win32')))
      .rejects.toThrow('VS Code did not open "安装包.exe" in the editor: 文件为二进制，无法作为文本打开. ');
    mocks.openTextDocument.mockRejectedValueOnce(new Error(`Access denied\n${'x'.repeat(400)}`));
    const long = await openRecordedFile('C:/workspace/notes.md', undefined, system('win32')).catch((error: Error) => error.message);
    expect(long).toContain('in the editor: Access denied xxx');
    expect(long).toContain('…. UnodeAi opens');
    expect(long).not.toContain('\n');
  });
});
