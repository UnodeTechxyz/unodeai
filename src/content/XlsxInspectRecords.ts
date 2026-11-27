import { join } from 'node:path';
import { WorkbookJsonIndex } from './WorkbookJsonIndex';
import type { XlsxManifest } from './XlsxWorkbook';
/** Random access to saved inventory details without scanning source rows on every page. */
export class XlsxInspectRecords {
  private readonly segments: Array<{ begin: number; count: number; kind: string; sheetId?: string; value(index: number): unknown }> = [];
  private current?: { key: string; file: WorkbookJsonIndex<unknown> };
  count = 0;
  constructor(directory: string, manifest: XlsxManifest) {
    const add = (kind: string, count: number, value: (index: number) => unknown, sheetId?: string) => {
      this.segments.push({ begin: this.count, count, kind, value, sheetId }); this.count += count;
    };
    try {
      add('workbook', 1, () => ({ date1904: manifest.date1904, cache: manifest.cache, calculation: manifest.calculation,
        external_links_present: manifest.externalLinksPresent, macro_content_present: manifest.macroContentPresent, sheet_count: manifest.sheets.length,
        shared_strings: manifest.sharedStrings, visibility: 'saved-hidden-state-only' }));
      for (const sheet of manifest.sheets) {
        add('sheet', 1, () => ({ sheet_id: sheet.sheetId, name: sheet.name, position: sheet.position, state: sheet.state,
          kind: sheet.kind, ...(sheet.gap ? { gap: sheet.gap } : {}), ...(sheet.metadata ? { metadata: sheet.metadata } : {}) }), sheet.sheetId);
        if (!sheet.directory || !sheet.metadata || sheet.gap) continue;
        const metadata = sheet.metadata;
        const lists: Array<[string, string, number]> = [['merge', 'merges', metadata.merges], ['array-formula-range', 'arrays', metadata.arrayFormulas],
          ['saved-column-definition', 'columns', metadata.columnDefinitions], ['saved-row-hidden-override', 'hidden-row-overrides', metadata.hiddenRowOverrides]];
        for (const [kind, name, count] of lists) {
          const folder = join(directory, sheet.directory);
          add(kind, count, index => ({ sheet_id: sheet.sheetId, saved_state_only: true, value: this.read(folder, name, index) }), sheet.sheetId);
        }
      }
    } catch (error) { this.close(); throw error; }
  }
  get(index: number): { kind: string; id: string; record: unknown } | undefined {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.count) return undefined;
    let low = 0; let high = this.segments.length;
    while (low < high) { const mid = Math.floor((low + high) / 2); if (this.segments[mid].begin + this.segments[mid].count <= index) low = mid + 1; else high = mid; }
    const segment = this.segments[low]; const at = index - segment.begin;
    return { kind: segment.kind, id: segment.kind === 'workbook' ? 'workbook' : segment.kind === 'sheet' ? segment.sheetId!
      : `${segment.sheetId}:${segment.kind}:${at}`, record: segment.value(at) };
  }
  private read(directory: string, name: string, index: number): unknown {
    const key = join(directory, name);
    if (this.current?.key !== key) { this.close(); this.current = { key, file: new WorkbookJsonIndex(directory, name) }; }
    const value = this.current.file.get(index); if (value === undefined) throw new Error('invalid-workbook-index'); return value;
  }
  close(): void { const current = this.current; this.current = undefined; current?.file.close(); }
}
