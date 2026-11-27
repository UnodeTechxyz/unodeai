import { readWorkbookBinding, workbookBindingBounds, workbookSuppliedValueMatches, validateWorkbookDataSelection,
  type WorkbookBindingInput, type WorkbookDataSelection, type WorkbookBoundCell } from '../WorkbookBinding';
import { DocumentFailure, documentPlainText, type CanonicalDocumentRequest, type DocumentBlock, type DocumentText } from './DocumentContracts';
import { canonicalDocumentTextContent } from './DocumentTextContent';
import { DocumentDataFailure } from './DocumentDataFailure';

/** Block indices are zero-based; target data rows/columns are one-based. Headers/unselected cells stay model-authored. */
export interface DocumentSourceBinding {
  block_index: number;
  target: { row: number; column: number };
  data_from: WorkbookDataSelection;
}
export interface DocumentDataFact {
  binding: number; block_index: number; table: number; target: { row: number; column: number };
  transformation_ref: string; selection: WorkbookDataSelection;
  sources: Array<{ snapshot_ref: string; sha256: string }>;
  rows: number; cells: number; unresolved_cells: number; structural_cells: number; normalized_cells: number; partial: boolean;
  supplied: { cells: number; differences: number };
  output?: { status: 'passed' | 'failed' | 'not-performed'; compared_cells: number; differences: number; package_sha256: string; text_comparison: 'document-canonical-text' };
}
export interface DocumentBindingExpectation { fact: DocumentDataFact; rows: string[][] }
export type SourceBoundDocumentRequest = CanonicalDocumentRequest & { source_bindings?: DocumentSourceBinding[] };
const invalid = (): never => { throw new DocumentFailure('invalid-input'); };
const positive = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
export function validateDocumentSourceBindings(input: unknown): DocumentSourceBinding[] {
  if (!Array.isArray(input)) return invalid();
  return input.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['block_index', 'target', 'data_from'].includes(key))
      || !Number.isSafeInteger(value.block_index) || value.block_index < 0) return invalid();
    const target = value.target;
    if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(key => !['row', 'column'].includes(key))
      || !positive(target.row) || !positive(target.column)) return invalid();
    try { return { block_index: value.block_index, target: { row: target.row, column: target.column }, data_from: validateWorkbookDataSelection(value.data_from) }; }
    catch { return invalid(); }
  });
}
export function documentDataRefs(request: SourceBoundDocumentRequest): string[] {
  return [...new Set((request.source_bindings ?? []).map(binding => binding.data_from.transformation_ref))];
}
/** Actual target table ordinal includes the fixed signature tables in word/document.xml. */
export function documentBindingTableOrdinal(blocks: DocumentBlock[], index: number): number {
  let count = 0;
  for (let at = 0; at <= index; at++) {
    const block = blocks[at]; if (block.type === 'table') count++;
    else if (block.type === 'signature') count += Math.ceil(block.parties.length / 2);
  }
  return count;
}
export function documentBindingTargets(request: SourceBoundDocumentRequest, inputs: readonly WorkbookBindingInput[]) {
  const targets: Array<{ block: number; firstRow: number; lastRow: number; firstColumn: number; lastColumn: number }> = [];
  for (const binding of request.source_bindings ?? []) {
    const block = request.document.blocks[binding.block_index]; const input = inputs.find(input => input.transformationRef === binding.data_from.transformation_ref);
    if (!block || block.type !== 'table' || !input) throw new DocumentDataFailure('selection');
    let first: number; let last: number;
    try { ({ first, last } = workbookBindingBounds(input, binding.data_from)); } catch { throw new DocumentDataFailure('selection'); }
    const target = { block: binding.block_index, firstRow: binding.target.row, lastRow: binding.target.row + Math.max(0, last - first + 1) - 1,
      firstColumn: binding.target.column, lastColumn: binding.target.column + binding.data_from.fields.length - 1 };
    if (target.lastColumn > block.headers.length || !Number.isSafeInteger(target.lastRow)) throw new DocumentDataFailure('selection');
    if (target.lastRow >= target.firstRow && targets.some(before => before.block === target.block
      && before.firstRow <= target.lastRow && target.firstRow <= before.lastRow && before.firstColumn <= target.lastColumn && target.firstColumn <= before.lastColumn)) throw new DocumentDataFailure('selection');
    if (target.lastRow >= target.firstRow) targets.push(target);
  }
}
/** Fixed worker operation. No model value becomes a claimed source value; unrelated model text remains untouched. */
export function bindDocumentData(request: SourceBoundDocumentRequest, inputs: readonly WorkbookBindingInput[], progress: () => void = () => {}) {
  if (!request.source_bindings?.length) return { request, expectations: [] as DocumentBindingExpectation[] };
  documentBindingTargets(request, inputs);
  const document = structuredClone(request.document); const expectations: DocumentBindingExpectation[] = [];
  for (const [index, binding] of (request.source_bindings ?? []).entries()) {
    const block = document.blocks[binding.block_index] as Extract<DocumentBlock, { type: 'table' }>;
    const suppliedBlock = request.document.blocks[binding.block_index] as Extract<DocumentBlock, { type: 'table' }>;
    const input = inputs.find(input => input.transformationRef === binding.data_from.transformation_ref)!;
    const fact: DocumentDataFact = { binding: index, block_index: binding.block_index, table: documentBindingTableOrdinal(document.blocks, binding.block_index), target: binding.target,
      transformation_ref: input.transformationRef, selection: binding.data_from, sources: [], rows: 0, cells: 0, unresolved_cells: 0, structural_cells: 0, normalized_cells: 0,
      partial: input.manifest.table.partial === true, supplied: { cells: 0, differences: 0 } };
    for (const source of input.manifest.source_reads) {
      const record = source as { snapshot_ref?: unknown; source_sha256?: unknown };
      if (typeof record.snapshot_ref === 'string' && typeof record.source_sha256 === 'string'
        && !fact.sources.some(source => source.snapshot_ref === record.snapshot_ref)) fact.sources.push({ snapshot_ref: record.snapshot_ref, sha256: record.source_sha256 });
    }
    const rows: string[][] = []; let targetRow = binding.target.row - 1;
    for (const row of readWorkbookBinding(input, binding.data_from, progress)) {
      for (let repeat = 0; repeat < row.repeat; repeat++, targetRow++) {
        progress();
        while (block.rows.length <= targetRow) {
          progress(); block.rows.push(Array.from({ length: block.headers.length }, (): DocumentText => [{ text: '', bold: false, language: document.language }]));
        }
        const text: string[] = [];
        for (let column = 0; column < row.cells.length; column++) {
          const at = binding.target.column - 1 + column; const before = suppliedBlock.rows[targetRow]?.[at]; const cell: WorkbookBoundCell = row.cells[column];
          if (before) { fact.supplied.cells++; if (!workbookSuppliedValueMatches(documentPlainText(before), cell)) fact.supplied.differences++; }
          const style = before?.[0] ?? { bold: false, language: document.language };
          let content: string;
          try { content = canonicalDocumentTextContent(cell.text.replace(/\r\n?/g, '\n'), true); } catch (error) {
            if (error instanceof DocumentFailure && error.code === 'invalid-input') throw new DocumentDataFailure('source-text-unrepresentable');
            throw error;
          }
          if (content !== cell.text) fact.normalized_cells++;
          block.rows[targetRow][at] = [{ text: content, bold: style.bold, language: style.language }];
          text.push(content); fact.cells++;
          if (cell.state === 'unresolved') fact.unresolved_cells++; else if (cell.state === 'structural') fact.structural_cells++;
        }
        rows.push(text); fact.rows++;
      }
    }
    expectations.push({ fact, rows });
  }
  return { request: { ...request, document }, expectations };
}
