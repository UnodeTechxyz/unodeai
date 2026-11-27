import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import type { PresentationDataFact, PresentationTableExpectation } from './PresentationDataBinding';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
/** PptxGenJS line splitting and XML end-of-line normalization; numeric/string content is otherwise exact. */
export const presentationTableComparisonText = (text: string) => text.replace(/\r*\n/g, '\n').replace(/\r/g, '\n');

/** Reads the actual editable table cells, including XML escapes, separate text runs and paragraphs. */
export function presentationTableTexts(xml: string): string[][][] {
  const tables: string[][][] = []; let table: string[][] | undefined; let row: string[] | undefined;
  let paragraphs: string[] | undefined; let inText = false;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => { throw new Error('unexpected-output-dtd'); });
  parser.on('opentag', tag => {
    if (tag.uri !== A) return;
    if (tag.local === 'tbl') { if (table) throw new Error('nested-output-table'); table = []; }
    else if (table && tag.local === 'tr') row = [];
    else if (row && tag.local === 'tc') paragraphs = [];
    else if (paragraphs && tag.local === 'p') paragraphs.push('');
    else if (paragraphs && tag.local === 't') inText = true;
    else if (paragraphs && tag.local === 'br') { if (!paragraphs.length) paragraphs.push(''); paragraphs[paragraphs.length - 1] += '\n'; }
  });
  const append = (value: string) => { if (inText && paragraphs) { if (!paragraphs.length) paragraphs.push(''); paragraphs[paragraphs.length - 1] += value; } };
  parser.on('text', append); parser.on('cdata', append);
  parser.on('closetag', tag => {
    if (tag.uri !== A) return;
    if (tag.local === 't') inText = false;
    else if (tag.local === 'tc' && paragraphs) { row!.push(paragraphs.join('\n')); paragraphs = undefined; }
    else if (tag.local === 'tr' && row) { table!.push(row); row = undefined; }
    else if (tag.local === 'tbl' && table) { tables.push(table); table = undefined; }
  });
  parser.write(xml).close(); return tables;
}

/** Package equality is a separate check from source computation and from visual/native application review. */
export async function checkPresentationData(bytes: Buffer, expected: readonly PresentationTableExpectation[]): Promise<PresentationDataFact[]> {
  if (!expected.length) return [];
  const digest = createHash('sha256').update(bytes).digest('hex'); const zip = await JSZip.loadAsync(bytes);
  const slides = new Map<number, string[][][]>(); const facts: PresentationDataFact[] = [];
  for (const item of expected) {
    let actual = slides.get(item.fact.slide);
    if (!actual) {
      const member = zip.file(`ppt/slides/slide${item.fact.slide}.xml`);
      actual = member ? presentationTableTexts(await member.async('string')) : []; slides.set(item.fact.slide, actual);
    }
    const rows = actual[item.fact.table - 1] ?? []; let differences = 0; let compared = 0;
    for (let row = 0; row < item.rows.length; row++) {
      for (let column = 0; column < item.rows[row].length; column++) {
        compared++; const actualText = rows[row]?.[column];
        if (actualText === undefined || presentationTableComparisonText(actualText) !== presentationTableComparisonText(item.rows[row][column])) differences++;
      }
      differences += Math.max(0, (rows[row]?.length ?? 0) - item.rows[row].length);
    }
    for (let row = item.rows.length; row < rows.length; row++) differences += Math.max(1, rows[row].length);
    facts.push({ ...item.fact, output: { status: differences ? 'failed' : 'passed', compared_cells: compared, differences, package_sha256: digest,
      text_comparison: 'powerpoint-line-breaks' } });
  }
  return facts;
}
