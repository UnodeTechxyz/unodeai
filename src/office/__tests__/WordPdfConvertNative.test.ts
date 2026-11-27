import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import JSZip from 'jszip';
import { NativeOfficeRenderer, type NativeDocxOutput } from '../NativeOfficeRenderer';
import { OfficeRenderPureHost } from '../OfficeRenderPureHost';
import { readWordPdfNotice } from '../platform/WordPdfNoticeSetting';
import { makePdf } from '../pdf/__tests__/pdfFixtures';

// Real Microsoft Word PDF -> DOCX conversion (design 6.3, 16.2). Windows with Word only, only when UNODE_REAL_WORD=1,
// and only when the user has already turned off Word's PDF-conversion notice: the test reads that setting and skips
// otherwise; it never writes it. The fixed helper starts its own hidden Word instance, uses it only when identified as
// newly created by it, quits only that instance and never ends any other Word process.
const wordProcesses = () => execFileSync('tasklist', ['/FI', 'IMAGENAME eq WINWORD.EXE', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
  .split(/\r?\n/).flatMap(line => /^"WINWORD\.EXE","(\d+)"/i.exec(line)?.[1] ?? []).sort();

const realWord = () => process.env.UNODE_REAL_WORD === '1';
// The platform is decided at collection; the opt-in when each case runs, so Windows discovery lists every case.
describe.runIf(process.platform === 'win32')('real Word PDF to DOCX conversion', () => {
  it('converts a text PDF in its own private hidden Word instance and leaves every other Word process running', async ctx => {
    if (!realWord()) { ctx.skip(); return; }
    if (await readWordPdfNotice() !== 'off') { ctx.skip(); return; }
    const root = await mkdtemp(join(tmpdir(), 'unode-word-pdf-native-'));
    try {
      const worker = join(root, 'OfficeRenderPureWorker.cjs');
      await build({ entryPoints: ['src/office/OfficeRenderPureWorker.ts'], outfile: worker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
      const before = wordProcesses(); let docx: (NativeDocxOutput & { data: Buffer }) | undefined;
      const result = await new NativeOfficeRenderer({ pure: new OfficeRenderPureHost(worker) }).render({
        source: Buffer.from(await makePdf([{ text: 'Native contract term twelve months' }, { text: 'Native payment thirty days' }])), kind: 'pdf', renderer: 'word', intent: 'convert-docx',
        signal: new AbortController().signal, current: () => true, beforeStart: async () => {}, onPage: () => { throw Error('no pages expected'); },
        onDocx: output => { docx = output; } });
      expect(result, JSON.stringify(result)).toMatchObject({ state: 'passed', application_owned: true, application_quit: true, document_closed: true,
        native_stop: { operation: 'completed', native_app: 'quit-by-helper', output: 'kept', staging: 'removed' } });
      expect(docx?.sha256).toBe(result.docx?.sha256);
      const text = (await (await JSZip.loadAsync(docx!.data)).file('word/document.xml')!.async('string')).replace(/<[^>]+>/g, '');
      expect(text).toContain('Native contract term twelve months'); expect(text).toContain('Native payment thirty days');
      expect(wordProcesses()).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 600000);
});
