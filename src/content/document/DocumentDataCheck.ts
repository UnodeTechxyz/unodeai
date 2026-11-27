import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import type { DocumentBindingExpectation, DocumentDataFact } from './DocumentDataBinding';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Actual main-document tables, including headers and fixed signature tables in their stored order. */
export function documentTableTexts(xml: string): string[][][] {
  const tables: string[][][] = []; let table: string[][] | undefined; let row: string[] | undefined;
  let paragraphs: string[] | undefined; let inText = false;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => { throw new Error('unexpected-output-dtd'); });
  const append = (value: string) => { if (paragraphs) { if (!paragraphs.length) paragraphs.push(''); paragraphs[paragraphs.length - 1] += value; } };
  parser.on('opentag', tag => {
    if (tag.uri !== W) return;
    if (tag.local === 'tbl') { if (table) throw new Error('nested-output-table'); table = []; }
    else if (table && tag.local === 'tr') row = [];
    else if (row && tag.local === 'tc') paragraphs = [];
    else if (paragraphs && tag.local === 'p') paragraphs.push('');
    else if (paragraphs && tag.local === 't') inText = true;
    else if (paragraphs && tag.local === 'br') append('\n');
    else if (paragraphs && tag.local === 'tab') append('\t');
  });
  parser.on('text', value => { if (inText) append(value); }); parser.on('cdata', value => { if (inText) append(value); });
  parser.on('closetag', tag => {
    if (tag.uri !== W) return;
    if (tag.local === 't') inText = false;
    else if (tag.local === 'tc' && paragraphs) { row!.push(paragraphs.join('\n')); paragraphs = undefined; }
    else if (tag.local === 'tr' && row) { table!.push(row); row = undefined; }
    else if (tag.local === 'tbl' && table) { tables.push(table); table = undefined; }
  });
  parser.write(xml).close(); return tables;
}
/** Only selected cells are checked: headers and other model-authored cells are not upgraded by nearby bindings. */
export async function checkDocumentData(bytes: Buffer, expected: readonly DocumentBindingExpectation[], format: 'docx' | 'pdf'): Promise<DocumentDataFact[]> {
  if (!expected.length) return [];
  const digest = createHash('sha256').update(bytes).digest('hex');
  // O4 owns actual PDF cell-map extraction. Filling a PDF is supported without a fabricated output-cell PASS.
  if (format === 'pdf') return expected.map(item => ({ ...item.fact, output: { status: 'not-performed', compared_cells: 0, differences: 0, package_sha256: digest, text_comparison: 'document-canonical-text' } }));
  const zip = await JSZip.loadAsync(bytes); const member = zip.file('word/document.xml'); const tables = member ? documentTableTexts(await member.async('string')) : [];
  return expected.map(item => {
    const table = tables[item.fact.table - 1]; let compared = 0; let differences = 0;
    for (let row = 0; row < item.rows.length; row++) for (let column = 0; column < item.rows[row].length; column++) {
      compared++;
      if (table?.[item.fact.target.row + row]?.[item.fact.target.column - 1 + column] !== item.rows[row][column]) differences++;
    }
    return { ...item.fact, output: { status: compared ? differences ? 'failed' : 'passed' : 'not-performed', compared_cells: compared, differences, package_sha256: digest, text_comparison: 'document-canonical-text' } };
  });
}
