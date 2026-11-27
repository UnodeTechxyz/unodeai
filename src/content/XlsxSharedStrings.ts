import type { SaxesTagNS } from 'saxes';
import { ReadOnlyOpc } from './OpcReadPackage';
import { SHEET_NS } from './XlsxInventory';
import { spreadsheetString } from './WorkbookXml';
import { WorkbookJsonIndex } from './WorkbookJsonIndex';
import type { XlsxRichString } from './XlsxCell';

/** Shared by inlineStr/is and sharedStrings/si; phonetic annotations are not duplicated into the value. */
export class XlsxStringCollector {
  private readonly path: string[] = [];
  private readonly pieces: string[] = []; private readonly runs: Array<{ text: string }> = [];
  private chunks: string[] = []; private textDepth = 0; private unresolved = false;
  open(tag: SaxesTagNS): void {
    this.path.push(SHEET_NS.has(tag.uri) ? tag.local : '?');
    if (tag.local === 't' && SHEET_NS.has(tag.uri) && (this.path.length === 2 || (this.path.length === 3 && this.path[1] === 'r'))) {
      this.textDepth = this.path.length; this.chunks = [];
    }
  }
  text(value: string): void { if (this.textDepth && this.path.length === this.textDepth) this.chunks.push(value); }
  close(): void {
    if (this.textDepth && this.path.length === this.textDepth) {
      const decoded = spreadsheetString(this.chunks.join('')); this.pieces.push(decoded.text); this.unresolved ||= decoded.escapedCodeUnitsUnresolved;
      if (this.path.length === 3) this.runs.push({ text: decoded.text }); this.textDepth = 0; this.chunks = [];
    }
    this.path.pop();
  }
  value(): XlsxRichString { return { text: this.pieces.join(''), ...(this.runs.length ? { runs: this.runs } : {}),
    ...(this.unresolved ? { escapedCodeUnitsUnresolved: true } : {}) }; }
}

export async function indexXlsxSharedStrings(pkg: ReadOnlyOpc, part: string | undefined, directory: string): Promise<number> {
  const index = new WorkbookJsonIndex<XlsxRichString>(directory, 'shared-strings', true); let depth = 0; let collector: XlsxStringCollector | undefined;
  try {
    if (!part) return 0;
    await pkg.xml(part, { open(tag) {
      depth++; if (depth === 1 && (tag.local !== 'sst' || !SHEET_NS.has(tag.uri))) throw new Error('invalid-shared-strings');
      if (depth === 2 && tag.local === 'si' && SHEET_NS.has(tag.uri)) collector = new XlsxStringCollector();
      collector?.open(tag);
    }, text(text) { collector?.text(text); }, close() {
      collector?.close(); if (depth === 2 && collector) { index.append(collector.value()); collector = undefined; } depth--;
    } }); return index.count;
  } finally { index.close(); }
}
