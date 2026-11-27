import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO as RATIO, CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES as FLOOR } from '../../content/ContentAssetStore';
import { scanWorkbookForRecalc, stripRecalcCopy } from '../WorkbookRecalcPackage';
import { WorkbookRecalcEngine, type WorkbookRecalcEngineResult } from '../WorkbookRecalcEngine';
import { createWorkbookPackage } from '../WorkbookCreate';
import { validateWorkbookCreateRequest } from '../WorkbookEditContracts';
import type { WorkbookRecalcTarget } from '../WorkbookRecalcContracts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function excel(source: Buffer, targets: WorkbookRecalcTarget[]): Promise<WorkbookRecalcEngineResult> {
  const engine = new WorkbookRecalcEngine({ nativeTimeoutMs: 120_000 });
  try {
    return await engine.run({ source, engine: 'excel', targets, date1904: false, signal: new AbortController().signal, current: () => true, authorize: async () => {}, readCopy: async () => [] });
  } finally { await engine.dispose(); }
}

// Real Excel, opt-in like the real Word round trip: the fixed helper creates its own hidden instance, proves it new and
// empty before using it, and quits only that instance. No other Excel or Word process is touched.
const realExcel = () => process.env.UNODE_REAL_EXCEL === '1';
// The platform is decided at collection; the opt-in when each case runs, so Windows discovery lists every case.
describe.runIf(process.platform === 'win32')('real Excel recalculation of a workbook with an Excel 4 macro sheet', () => {
  it('Excel opens the stripped copy without a prompt or hang, computes ordinary cells and quits its own instance', async ctx => {
    if (!realExcel()) { ctx.skip(); return; }
    const root = await mkdtemp(join(tmpdir(), 'unode-excel-native-'));
    try {
      // A workbook as UnodeAi writes it, then an Excel 4 macro sheet (Excel's own form) with an Auto_Open name placed first.
      const created = await createWorkbookPackage({ directory: root, sheets: validateWorkbookCreateRequest({ schema_version: 1, path: 'x.xlsx',
        sheets: [{ name: 'Data', rows: [[null, 41]], formulas: { A1: 'B1+1', E1: 'Macro1!A1', F1: 'IFERROR(INDIRECT("Macro1!A1"),99)' } }] }).sheets }, RATIO, FLOOR, () => {});
      const zip = await JSZip.loadAsync(created.bytes);
      const book = await zip.file('xl/workbook.xml')!.async('string'); const relNs = /xmlns:r="([^"]+)"/.exec(book)![1];
      zip.file('xl/workbook.xml', book.replace(/<sheets>/, `<sheets><sheet name="Macro1" sheetId="9" state="hidden" xmlns:rm="${relNs}" rm:id="rMacro"/>`)
        .replace('</sheets>', '</sheets><definedNames><definedName name="Auto_Open">Macro1!$A$1</definedName></definedNames>'));
      const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
      zip.file('xl/_rels/workbook.xml.rels', rels.replace('</Relationships>', '<Relationship Id="rMacro" Type="http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet" Target="macrosheets/sheet1.xml"/></Relationships>'));
      const types = await zip.file('[Content_Types].xml')!.async('string');
      zip.file('[Content_Types].xml', types.replace('</Types>', '<Override PartName="/xl/macrosheets/sheet1.xml" ContentType="application/vnd.ms-excel.macrosheet+xml"/></Types>'));
      // Harmless even if it ran: the macro only returns.
      zip.file('xl/macrosheets/sheet1.xml', '<xm:macrosheet xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main" xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>RETURN()</f></c></row></sheetData></xm:macrosheet>');
      const source = await zip.generateAsync({ type: 'nodebuffer' }); const path = join(root, 'book.xlsx'); await writeFile(path, source);
      const scan = await scanWorkbookForRecalc({ operation: 'recalc-scan', source: path, targets: { cells: [{ sheet_id: 'sheet-2', refs: ['A1', 'E1', 'F1'] }] } }, RATIO, FLOOR, () => {});
      expect(scan.macro_sheets).toEqual(['Macro1']); expect(scan.macro_dependent).toEqual(['sheet-2!E1', 'sheet-2!F1']);
      const stripped = await stripRecalcCopy({ operation: 'recalc-strip', source: path, sourceSha256: sha(source), directory: root, targets: scan.targets }, RATIO, FLOOR, () => {});
      const started = Date.now();
      const run = await excel(Buffer.from(stripped.bytes), stripped.targets);
      expect(run, JSON.stringify(run)).toMatchObject({ state: 'passed', native_app: 'quit-by-helper', staging_cleanup: 'removed' });
      expect(run.values[0]).toMatchObject({ cell: 'A1', type: 'n', value: '42', recalculated: true });
      // The INDIRECT fallback Excel computes on the stripped copy is what the host reports as depends-on-macro-sheet.
      expect(run.values[2]).toMatchObject({ cell: 'F1', type: 'n', value: '99' });
      expect(Date.now() - started).toBeLessThan(120_000);
      expect(await readFile(path)).toEqual(source);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 300_000);
});
