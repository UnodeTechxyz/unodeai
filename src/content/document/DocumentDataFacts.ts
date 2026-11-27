import type { DocumentDataFact } from './DocumentDataBinding';
import { validateWorkbookDataSelection } from '../WorkbookBinding';
const record = (raw: unknown, keys: readonly string[]): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
  && Object.keys(raw).every(key => keys.includes(key));
const count = (raw: unknown): raw is number => Number.isSafeInteger(raw) && (raw as number) >= 0;
const nonce = (raw: unknown, prefix: string): raw is string => typeof raw === 'string' && new RegExp(`^${prefix}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`).test(raw);
/** Closed projection for the worker boundary and receipt reloads. No source text/private paths are retained here. */
export function parseDocumentDataFacts(raw: unknown, digest: string, format: 'docx' | 'pdf'): DocumentDataFact[] | undefined {
  if (!Array.isArray(raw) || !/^[a-f0-9]{64}$/.test(digest)) return undefined;
  const facts: DocumentDataFact[] = [];
  for (const value of raw) {
    if (!record(value, ['binding', 'block_index', 'table', 'target', 'transformation_ref', 'selection', 'sources', 'rows', 'cells',
      'unresolved_cells', 'structural_cells', 'normalized_cells', 'partial', 'supplied', 'output'])
      || !count(value.binding) || !count(value.block_index) || !count(value.table) || !value.table || !nonce(value.transformation_ref, 'transformation')
      || !record(value.target, ['row', 'column']) || !count(value.target.row) || !value.target.row || !count(value.target.column) || !value.target.column
      || !['rows', 'cells', 'unresolved_cells', 'structural_cells', 'normalized_cells'].every(key => count(value[key])) || typeof value.partial !== 'boolean'
      || !record(value.supplied, ['cells', 'differences']) || !count(value.supplied.cells) || !count(value.supplied.differences)
      || value.supplied.differences > value.supplied.cells || value.supplied.cells > (value.cells as number)
      || !record(value.output, ['status', 'compared_cells', 'differences', 'package_sha256', 'text_comparison'])
      || !['passed', 'failed', 'not-performed'].includes(value.output.status as string) || value.output.package_sha256 !== digest
      || value.output.text_comparison !== 'document-canonical-text' || !count(value.output.compared_cells) || !count(value.output.differences)
      || !Array.isArray(value.sources) || !value.sources.length) return undefined;
    let selection: DocumentDataFact['selection'];
    try { selection = validateWorkbookDataSelection(value.selection); } catch { return undefined; }
    if (selection.transformation_ref !== value.transformation_ref || value.cells !== (value.rows as number) * selection.fields.length
      || (value.unresolved_cells as number) + (value.structural_cells as number) > (value.cells as number) || (value.normalized_cells as number) > (value.cells as number)) return undefined;
    const output = value.output;
    const compared = output.compared_cells as number; const differences = output.differences as number;
    if (output.status === 'not-performed' ? output.compared_cells !== 0 || output.differences !== 0 || (format === 'docx' && value.cells !== 0)
      : format !== 'docx' || compared !== value.cells || compared === 0 || differences > compared
        || (output.status === 'passed' ? output.differences !== 0 : output.differences === 0)) return undefined;
    const sources: DocumentDataFact['sources'] = [];
    for (const source of value.sources) {
      if (!record(source, ['snapshot_ref', 'sha256']) || !nonce(source.snapshot_ref, 'workbook') || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) return undefined;
      sources.push({ snapshot_ref: source.snapshot_ref, sha256: source.sha256 });
    }
    facts.push({ binding: value.binding, block_index: value.block_index, table: value.table, target: { row: value.target.row, column: value.target.column },
      transformation_ref: value.transformation_ref, selection, sources, rows: value.rows as number, cells: value.cells as number,
      unresolved_cells: value.unresolved_cells as number, structural_cells: value.structural_cells as number, normalized_cells: value.normalized_cells as number,
      partial: value.partial, supplied: { cells: value.supplied.cells, differences: value.supplied.differences },
      output: { status: output.status as 'passed' | 'failed' | 'not-performed', compared_cells: compared, differences,
        package_sha256: digest, text_comparison: 'document-canonical-text' } });
  }
  if (new Set(facts.map(fact => fact.binding)).size !== facts.length) return undefined;
  return facts;
}
