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
import { openRecordedFile } from '../openRecordedFile';

beforeEach(() => { vi.resetAllMocks(); mocks.openExternal.mockResolvedValue(true); });
describe('recorded file opening after path admission', () => {
  it.each(['.docx', '.xlsx', '.pptx', '.pdf', '.PDF'])('opens %s with the system app without reading it as text', async extension => {
    await openRecordedFile(`C:/workspace/合同${extension}`, { line: 9 });
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith({ scheme: 'file', fsPath: `C:/workspace/合同${extension}` });
    expect(mocks.openTextDocument).not.toHaveBeenCalled();
    expect(mocks.showTextDocument).not.toHaveBeenCalled();
  });
  it('keeps text navigation and validates the requested line and column', async () => {
    const at = { line: 2, character: 1 }; const validatePosition = vi.fn(() => at);
    const document = { validatePosition }; mocks.openTextDocument.mockResolvedValue(document);
    await openRecordedFile('C:/workspace/source.ts', { line: 3, column: 2 });
    expect(validatePosition).toHaveBeenCalledWith(at);
    expect(mocks.showTextDocument).toHaveBeenCalledWith(document, { preview: false, selection: { start: at, end: at } });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
  it.each(['.exe', '.msi', '.scr', '.com', '.cpl', '.lnk', '.bin', '.docx.exe'])('offers Reveal for %s without ever launching it', async extension => {
    mocks.openTextDocument.mockRejectedValue(new Error('cannot open file. Detail: File seems to be binary and cannot be opened as text'));
    await openRecordedFile(`C:/workspace/data${extension}`);
    expect(mocks.openExternal).not.toHaveBeenCalled(); expect(mocks.showTextDocument).not.toHaveBeenCalled();
    expect(mocks.showWarningMessage).toHaveBeenCalledExactlyOnceWith(
      'UnodeAi opens Word, Excel, PowerPoint and PDF files in their app, and text files in the editor. '
      + `To open "data${extension}", reveal it in File Explorer and open it there.`, 'Reveal in File Explorer');
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });
  it('reveals the exact file only when the user chooses Reveal, including localized errors', async () => {
    mocks.openTextDocument.mockRejectedValue(new Error('文件为二进制，无法作为文本打开'));
    mocks.showWarningMessage.mockResolvedValue('Reveal in File Explorer');
    await openRecordedFile('C:/workspace/安装包.exe');
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.executeCommand).toHaveBeenCalledExactlyOnceWith('revealFileInOS', { scheme: 'file', fsPath: 'C:/workspace/安装包.exe' });
  });
  it('offers Reveal for other text-opening failures and reports document app launch failure', async () => {
    const error = new Error('Access denied'); mocks.openTextDocument.mockRejectedValue(error);
    await openRecordedFile('C:/workspace/missing.txt');
    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(mocks.openExternal).not.toHaveBeenCalled();
    mocks.openExternal.mockResolvedValue(false);
    await expect(openRecordedFile('C:/workspace/report.pdf')).rejects.toThrow('system could not open');
  });
});
