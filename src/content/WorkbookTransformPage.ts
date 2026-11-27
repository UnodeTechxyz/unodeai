import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkbookTransformManifest } from './WorkbookTransform';
import { WorkbookTableReader } from './WorkbookTable';
import { WorkbookJsonIndex } from './WorkbookJsonIndex';
import { appendWorkbookJsonItem } from './WorkbookJsonPage';
import { workbookOutputSize, type CellPosition, type PageBudget } from './WorkbookPage';
export interface WorkbookTransformPage { schema_version: 1; transformation_ref: string; data_ref: string; delivery: 'prepared'; prepared_fragments: unknown[];
  delivery_ref?: string;
  next_cursor: string | null; remaining: CellPosition | null }
/** Metadata, per-group facts and row blocks all count against the actual route bound. Private paths stay private. */
export function readWorkbookTransformPage(directory: string, manifest: WorkbookTransformManifest, transformationRef: string, dataRef: string,
  start: CellPosition, cursor: string, budget: PageBudget, progress: () => void): WorkbookTransformPage {
  if (!Number.isSafeInteger(budget.limit) || budget.limit < 1 || !Number.isSafeInteger(budget.reserved) || budget.reserved < 0) throw new Error('invalid-budget');
  if (!Number.isSafeInteger(start.row) || start.row < 1 || start.column !== 1 || !Number.isSafeInteger(start.byte) || start.byte < 0) throw new Error('invalid-cursor');
  const page: WorkbookTransformPage = { schema_version: 1, transformation_ref: transformationRef, data_ref: dataRef, delivery: 'prepared',
    delivery_ref: `workbook-delivery-${randomUUID()}`, prepared_fragments: [], next_cursor: cursor, remaining: { ...start } };
  if (workbookOutputSize(JSON.stringify(page), budget) + budget.reserved > budget.limit) throw new Error('route-bound-too-small');
  let total = 1; const lists = manifest.factLists.map((list, index) => { const item = { ...list, begin: total, ordinal: index }; total += list.count; return item; });
  const firstCell = total; const cellColumns = Math.max(1, manifest.table.columns.length); total += manifest.table.blocks * cellColumns;
  let facts: { name: string; index: WorkbookJsonIndex<unknown> } | undefined; let rows: WorkbookTableReader | undefined;
  let rowBlock: ReturnType<WorkbookTableReader['block']>; let rowBlockIndex = -1;
  try {
    for (let at = start.row - 1; at < total; at++) {
      progress(); let kind: string; let id: string; let record: unknown;
      if (at === 0) {
        kind = 'transformation'; id = 'metadata';
        record = { computation: manifest.computation, computation_version: manifest.computation_version, plan: manifest.plan, executed_steps: manifest.executed_steps,
          source_reads: manifest.source_reads, operations: manifest.operations, table: { columns: manifest.table.columns, rows: manifest.table.rows, blocks: manifest.table.blocks,
            group_by: manifest.table.groupBy ?? [], partial: manifest.table.partial === true, units: manifest.table.units ?? {} },
          aggregate_fact_lists: manifest.factLists.map(list => ({ step: list.step, count: list.count })),
          precision: 'exact-rational; chart binary conversion requires its own representability result', coverage: 'host-computation; model delivery not inferred' };
      } else if (at < firstCell) {
        const list = lists.find(list => at >= list.begin && at < list.begin + list.count)!;
        if (facts?.name !== list.name) { facts?.index.close(); facts = undefined; facts = { name: list.name, index: new WorkbookJsonIndex(directory, list.name) }; }
        kind = 'aggregate-fact'; id = `fact-${list.ordinal}-${at - list.begin}`; record = { step: list.step, fact: facts.index.get(at - list.begin) };
      } else {
        rows ??= new WorkbookTableReader(join(directory, manifest.table.directory), manifest.table.columns);
        const blockIndex = Math.floor((at - firstCell) / cellColumns); const column = (at - firstCell) % cellColumns;
        if (rowBlockIndex !== blockIndex) { rowBlock = rows.block(blockIndex); rowBlockIndex = blockIndex; }
        if (!rowBlock) throw new Error('invalid-workbook-index');
        const field = manifest.table.columns[column]; kind = field === undefined ? 'row' : 'table-cell'; id = `cell-${rowBlock.firstRow}-${column}`;
        record = field === undefined ? { firstRow: rowBlock.firstRow, repeat: rowBlock.repeat, cells: {}, ...(rowBlock.uncertain ? { uncertain: rowBlock.uncertain } : {}) }
          : { firstRow: rowBlock.firstRow, repeat: rowBlock.repeat, field, value: rowBlock.cells[field], ...(rowBlock.uncertain ? { uncertain: rowBlock.uncertain } : {}) };
      }
      const result = appendWorkbookJsonItem(page, kind, id, record, at === start.row - 1 ? start.byte : 0, budget, (end, length) => {
        page.remaining = end === length ? at === total - 1 ? null : { row: at + 2, column: 1, byte: 0 } : { row: at + 1, column: 1, byte: end };
        page.next_cursor = page.remaining ? cursor : null;
      });
      if (result !== 'whole') return page;
    }
    page.remaining = null; page.next_cursor = null; return page;
  } finally { facts?.index.close(); rows?.close(); }
}
