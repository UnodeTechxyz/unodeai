import { createReadStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO, CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES } from './ContentAssetStore';
import { ReadOnlyOpc } from './OpcReadPackage';
import { inspectXlsxInventory, type XlsxInventory, type XlsxSheetInfo } from './XlsxInventory';
import { indexXlsxSharedStrings } from './XlsxSharedStrings';
import { readXlsxStyles } from './XlsxStyles';
import { indexXlsxSheet, type XlsxSheetMetadata } from './XlsxSheet';
import { WorkbookJsonIndex } from './WorkbookJsonIndex';

export interface XlsxIndexedSheet extends XlsxSheetInfo { directory?: string; metadata?: XlsxSheetMetadata }
export interface XlsxManifest extends Omit<XlsxInventory, 'sheets'> { sha256: string; sheets: XlsxIndexedSheet[]; sharedStrings: number }
export async function parseXlsxSnapshot(source: string, directory: string, progress: () => void): Promise<XlsxManifest> {
  const hash = createHash('sha256'); for await (const bytes of createReadStream(source)) { hash.update(bytes); progress(); }
  const pkg = await ReadOnlyOpc.open(source, CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO, CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES, progress);
  try {
    const inventory = await inspectXlsxInventory(pkg);
    const sharedStrings = await indexXlsxSharedStrings(pkg, inventory.sharedStringsPart, directory);
    const formats = new WorkbookJsonIndex(directory, 'number-formats', true);
    try { for (const format of await readXlsxStyles(pkg, inventory.stylesPart)) formats.append(format); } finally { formats.close(); }
    const sheets: XlsxIndexedSheet[] = [];
    for (const sheet of inventory.sheets) {
      if (sheet.gap || sheet.kind !== 'worksheet' || !sheet.part) { sheets.push({ ...sheet, gap: sheet.gap ?? 'unsupported-sheet-kind' }); continue; }
      const name = `sheet-${sheet.position}`; const target = join(directory, name); await mkdir(target);
      try { const metadata = await indexXlsxSheet(pkg, sheet.part, target); sheets.push({ ...sheet, directory: name, metadata }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException)?.code || error instanceof RangeError) throw error;
        // A broken selected sheet is a precise input gap; independent readable sheets remain available.
        const known = new Set(['corrupt-office-part', 'office-expansion-budget', 'unsupported-xml-dtd', 'unsupported-xml-encoding', 'missing-or-ambiguous-office-part',
          'encrypted-office-part', 'unsupported-sheet-root', 'invalid-worksheet-reference', 'invalid-workbook-boolean', 'invalid-worksheet-columns',
          'invalid-worksheet-row', 'ambiguous-worksheet-cell', 'ambiguous-shared-formula']);
        const gap = error instanceof Error && known.has(error.message) ? error.message : 'invalid-worksheet-xml';
        await rm(target, { recursive: true, force: true }); sheets.push({ ...sheet, gap });
      }
    }
    return { ...inventory, sha256: hash.digest('hex'), sheets, sharedStrings };
  } finally { pkg.close(); }
}
