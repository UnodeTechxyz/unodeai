import { createHash } from 'node:crypto';
import { WorkbookJsonIndex } from './WorkbookJsonIndex';
import { WorkbookValueCache } from './WorkbookValueCache';
import type { WorkbookDatum, WorkbookRow, WorkbookRowBlock } from './WorkbookAggregate';
interface StoredRow { values: number[]; repeat: number; firstRow: number; uncertain?: string }
export interface WorkbookTableInfo { directory: string; columns: string[]; rows: number; blocks: number; groupBy?: string[]; partial?: boolean;
  units?: Record<string, { from: string; to: string; declared: true }> }
/** Repeated long source strings are stored once, not multiplied into every intermediate row. */
export class WorkbookTableWriter {
  private readonly values: WorkbookJsonIndex<WorkbookDatum>; private readonly rows: WorkbookJsonIndex<StoredRow>;
  private readonly hashes = new Map<string, number[]>(); private readonly cache = new WorkbookValueCache<WorkbookDatum>();
  count = 0;
  constructor(directory: string, readonly columns: string[], private readonly progress: () => void = () => {}) {
    this.values = new WorkbookJsonIndex(directory, 'values', true);
    try { this.rows = new WorkbookJsonIndex(directory, 'rows', true); } catch (error) { this.values.close(); throw error; }
  }
  append(block: WorkbookRowBlock): void {
    if (!Number.isSafeInteger(block.repeat) || block.repeat < 1 || !Number.isSafeInteger(this.count + block.repeat)) throw new Error('invalid-row-repeat');
    const values: number[] = []; const rowMemo = new Map<WorkbookDatum, number>();
    for (const column of this.columns) {
      this.progress();
      const value = Object.hasOwn(block.cells, column) ? block.cells[column] : { kind: 'missing' as const, reason: 'absent-column' };
      const known = rowMemo.get(value); if (known !== undefined) { values.push(known); continue; }
      const text = JSON.stringify(value); const hash = createHash('sha256').update(text).digest('hex'); const candidates = this.hashes.get(hash) ?? [];
      let id = candidates.find(id => JSON.stringify(this.cache.get(id, () => this.values.get(id))) === text);
      if (id === undefined) { id = this.values.append(value); candidates.push(id); this.hashes.set(hash, candidates); }
      rowMemo.set(value, id); values.push(id);
    }
    this.rows.append({ values, repeat: block.repeat, firstRow: this.count + 1, ...(block.uncertain ? { uncertain: block.uncertain } : {}) }); this.count += block.repeat;
  }
  info(directory: string): WorkbookTableInfo { return { directory, columns: [...this.columns], rows: this.count, blocks: this.rows.count }; }
  close(): void { this.rows.close(); this.values.close(); }
}
export class WorkbookTableReader {
  private readonly values: WorkbookJsonIndex<WorkbookDatum>; private readonly rows: WorkbookJsonIndex<StoredRow>;
  private readonly cache = new WorkbookValueCache<WorkbookDatum>();
  private readonly positions: Map<string, number>;
  constructor(directory: string, readonly columns: string[]) {
    this.positions = new Map(columns.map((column, index) => [column, index]));
    this.values = new WorkbookJsonIndex(directory, 'values');
    try { this.rows = new WorkbookJsonIndex(directory, 'rows'); } catch (error) { this.values.close(); throw error; }
  }
  block(index: number, selected = this.columns): (WorkbookRowBlock & { firstRow: number }) | undefined {
    const record = this.rows.get(index); if (!record) return undefined;
    const cells: WorkbookRow = Object.create(null); const memo = new Map<number, WorkbookDatum>();
    for (const column of selected) {
      const at = this.positions.get(column); if (at === undefined) throw new Error('unknown-transform-column');
      const id = record.values[at]; const value = memo.get(id) ?? this.cache.get(id, () => this.values.get(id));
      if (value === undefined) throw new Error('invalid-workbook-index'); cells[column] = value;
      memo.set(id, value);
    }
    return { cells, repeat: record.repeat, firstRow: record.firstRow, ...(record.uncertain ? { uncertain: record.uncertain } : {}) };
  }
  async *read(selected = this.columns): AsyncGenerator<WorkbookRowBlock> { for (let at = 0; at < this.rows.count; at++) yield this.block(at, selected)!; }
  logicalRow(row: number, selected = this.columns): WorkbookRowBlock | undefined {
    let low = 0; let high = this.rows.count;
    while (low < high) { const middle = Math.floor((low + high) / 2); const record = this.rows.get(middle)!;
      if (record.firstRow + record.repeat <= row) low = middle + 1; else high = middle; }
    const block = this.block(low, selected); return block && row >= block.firstRow && row < block.firstRow + block.repeat ? { ...block, repeat: 1 } : undefined;
  }
  close(): void { this.rows.close(); this.values.close(); }
}
