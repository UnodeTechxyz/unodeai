import { describe, expect, it } from 'vitest';
import { startDocumentOpener, windowsDocumentOpener } from '../systemDocumentOpener';

describe('the Windows document opener', () => {
  // v0.9.102: measured on Windows 11 with File Explorer. Unquoted, "C:\x\合同,v2.txt" opened a Documents folder
  // window instead of the file; quoted, the file opened in its app. Chinese, spaces, &, %, # and commas all opened.
  it.each([
    'C:\\Work Docs\\WorkingDocuments\\Goodvision与MetaBlox_B300合同主要差异对比.pdf',
    'C:\\nospace_文件\\合同,v2.docx',
    'C:\\Docs\\R&D 100% #1 合同.xlsx',
    '\\\\server\\share\\报告.pptx',
  ])('gives File Explorer %s as one quoted argument, exactly as written', (file) => {
    expect(windowsDocumentOpener(file, 'C:\\Windows')).toEqual({ command: 'C:\\Windows\\explorer.exe', args: [`"${file}"`], verbatim: true });
  });

  it('names File Explorer by its full path, under SystemRoot or the Windows folder, never by a search', () => {
    expect(windowsDocumentOpener('D:\\a.pdf', 'D:\\WINNT').command).toBe('D:\\WINNT\\explorer.exe');
    expect(windowsDocumentOpener('D:\\a.pdf', undefined).command).toBe('C:\\Windows\\explorer.exe');
    expect(windowsDocumentOpener('D:\\a.pdf', '').command).toBe('C:\\Windows\\explorer.exe');
  });

  it('refuses a path holding a quotation mark, which no Windows path holds and quoting could not keep whole', () => {
    expect(() => windowsDocumentOpener('C:\\a" /select,"C:\\b.pdf', 'C:\\Windows')).toThrow('quotation mark');
  });
});

describe('starting the opener', () => {
  it('resolves once the program started, without waiting for it to end', async () => {
    const started = Date.now();
    await startDocumentOpener({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'], verbatim: false });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('rejects when the program cannot start', async () => {
    await expect(startDocumentOpener({ command: `${process.execPath}-missing`, args: [], verbatim: false })).rejects.toThrow(/ENOENT/);
  });
});
