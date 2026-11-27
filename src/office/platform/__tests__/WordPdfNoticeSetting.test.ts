import { expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { readWordPdfNotice, wordPdfNoticeFromQuery, WORD_PDF_NOTICE_KEY } from '../WordPdfNoticeSetting';

const line = (type: string, value: string) => `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Office\\16.0\\Word\\Options\r\n    DisableConvertPdfWarning    ${type}    ${value}\r\n\r\n`;
const root = path.win32.join(path.win32.parse(process.cwd()).root || '\\', 'SystemRootFixture');

it('is off only for an exact REG_DWORD 1', () => {
  expect(wordPdfNoticeFromQuery(line('REG_DWORD', '0x1'))).toBe('off');
  for (const output of [undefined, '', line('REG_DWORD', '0x0'), line('REG_DWORD', '0x2'), line('REG_SZ', '1'), line('REG_DWORD', '0x10')]) {
    expect(wordPdfNoticeFromQuery(output)).toBe('on');
  }
});

it('reads with one fixed read-only reg query of the user’s Word options, without a shell', async () => {
  const query = vi.fn(async () => line('REG_DWORD', '0x1'));
  expect(await readWordPdfNotice('win32', { SystemRoot: root }, query, file => file)).toBe('off');
  expect(query).toHaveBeenCalledWith(path.win32.join(root, 'System32', 'reg.exe'), ['query', WORD_PDF_NOTICE_KEY, '/v', 'DisableConvertPdfWarning']);
  expect(WORD_PDF_NOTICE_KEY).toBe('HKCU\\Software\\Microsoft\\Office\\16.0\\Word\\Options');
});

it('a failed query, a missing system root or an unresolvable reg.exe counts as the notice being on', async () => {
  expect(await readWordPdfNotice('win32', { SystemRoot: root }, async () => undefined, file => file)).toBe('on');
  expect(await readWordPdfNotice('win32', { SystemRoot: root }, async () => { throw Error('timeout'); }, file => file)).toBe('on');
  expect(await readWordPdfNotice('win32', {}, vi.fn(), file => file)).toBe('on');
  expect(await readWordPdfNotice('win32', { SystemRoot: root }, vi.fn(), () => { throw Error('missing'); })).toBe('on');
});

it('other platforms have no Word adapter and never query', async () => {
  const query = vi.fn();
  for (const platform of ['linux', 'darwin'] as const) expect(await readWordPdfNotice(platform, { SystemRoot: root }, query)).toBe('platform-unsupported');
  expect(query).not.toHaveBeenCalled();
});
