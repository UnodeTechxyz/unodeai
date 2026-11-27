import { readWorkbookBinding, workbookSuppliedValueMatches, type WorkbookBindingInput, type WorkbookDataSelection } from '../content/WorkbookBinding';
import type { PresentationDeck } from './PresentationContracts';
import { validatePresentationRequest, PresentationInputFailure } from './PresentationContracts';
import { PresentationDataFailure } from './PresentationDataFailure';

export interface PresentationDataFact {
  slide: number; object: number; table: number;
  transformation_ref: string; selection: WorkbookDataSelection;
  sources: Array<{ snapshot_ref: string; sha256: string }>;
  rows: number; cells: number; unresolved_cells: number; structural_cells: number; partial: boolean;
  supplied: { present: boolean; cells: number; differences: number };
  output?: { status: 'passed' | 'failed'; compared_cells: number; differences: number; package_sha256: string; text_comparison: 'powerpoint-line-breaks' };
}
export interface PresentationTableExpectation { rows: string[][]; fact: PresentationDataFact }
export function presentationDataRefs(deck: PresentationDeck): string[] {
  return [...new Set(deck.slides.flatMap(slide => slide.objects.flatMap(object => (object.type === 'table' || object.type === 'chart') && object.data_from ? [object.data_from.transformation_ref] : [])))];
}

/** Fills cells from actual private data, preserving exact numeric text and separately counting supplied discrepancies. */
export function bindPresentationData(deck: PresentationDeck, inputs: readonly WorkbookBindingInput[], progress: () => void = () => {}) {
  const available = new Map(inputs.map(input => [input.transformationRef, input])); const expectations: PresentationTableExpectation[] = [];
  const slides = deck.slides.map((slide, slideIndex) => {
    let tableIndex = 0;
    const objects = slide.objects.map((object, objectIndex) => {
      if (object.type !== 'table') return object;
      const targetTable = ++tableIndex; if (!object.data_from) return object;
      const selection = object.data_from; const input = available.get(selection.transformation_ref);
      if (!input) throw new PresentationInputFailure('data_from', 'Use a transformation_ref returned by this agent’s transform_workbook.');
      const rows: string[][] = [[...selection.fields]];
      const fact: PresentationDataFact = { slide: slideIndex + 1, object: objectIndex + 1, table: targetTable,
        transformation_ref: input.transformationRef, selection, sources: [], rows: 0, cells: selection.fields.length,
        unresolved_cells: 0, structural_cells: 0, partial: input.manifest.table.partial === true,
        supplied: { present: object.rows.length > 0, cells: object.rows.reduce((sum, row) => sum + row.length, 0), differences: 0 } };
      for (const source of input.manifest.source_reads) {
        const record = source as { snapshot_ref?: unknown; source_sha256?: unknown };
        if (typeof record.snapshot_ref === 'string' && typeof record.source_sha256 === 'string'
          && !fact.sources.some(source => source.snapshot_ref === record.snapshot_ref)) fact.sources.push({ snapshot_ref: record.snapshot_ref, sha256: record.source_sha256 });
      }
      if (fact.supplied.present) {
        for (let column = 0; column < selection.fields.length; column++) if (object.rows[0]?.[column] !== selection.fields[column]) fact.supplied.differences++;
        fact.supplied.differences += Math.max(0, (object.rows[0]?.length ?? 0) - selection.fields.length);
      }
      for (const block of readWorkbookBinding(input, selection, progress)) {
        const text = block.cells.map(cell => cell.text);
        for (let repeat = 0; repeat < block.repeat; repeat++) {
          progress(); const supplied = object.rows[rows.length];
          if (fact.supplied.present) {
            for (let column = 0; column < block.cells.length; column++) if (supplied?.[column] === undefined || !workbookSuppliedValueMatches(supplied[column], block.cells[column])) fact.supplied.differences++;
            fact.supplied.differences += Math.max(0, (supplied?.length ?? 0) - block.cells.length);
          }
          rows.push(text); fact.rows++; fact.cells += text.length;
        }
        fact.unresolved_cells += block.cells.filter(cell => cell.state === 'unresolved').length * block.repeat;
        fact.structural_cells += block.cells.filter(cell => cell.state === 'structural').length * block.repeat;
      }
      if (fact.supplied.present) for (let row = rows.length; row < object.rows.length; row++) fact.supplied.differences += object.rows[row].length;
      expectations.push({ rows, fact });
      return { ...object, rows };
    });
    return { ...slide, objects };
  });
  // Actual source strings must satisfy the same Office/XML structural rules as existing unbound text.
  try {
    const bound = validatePresentationRequest({ schema_version: 1, path: 'bound.pptx', deck: { ...deck, slides } }).deck;
    return { deck: bound, expectations };
  } catch (error) {
    if (expectations.length && error instanceof PresentationInputFailure) throw new PresentationDataFailure();
    throw error;
  }
}
