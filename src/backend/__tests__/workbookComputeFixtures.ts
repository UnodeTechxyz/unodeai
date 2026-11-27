export const COMPUTE_CSV = 'team,amount\r\nA,0.1\r\nA,0.2\r\nB,9007199254740993\r\nB,1';
export function workbookSumPlan(snapshotRef: string) {
  return { operation: 'compute', sources: [{ name: 'input', snapshot_ref: snapshotRef, range: 'A2:B5' }], steps: [
    { id: 'values', input: 'input', operation: 'select', columns: [{ column: 'A', as: 'team' }, { column: 'B', as: 'amount', as_number: true }] },
    { id: 'groups', input: 'values', operation: 'group', by: ['team'] },
    { id: 'totals', input: 'groups', operation: 'aggregate', fields: [{ operation: 'sum', field: 'amount', as: 'total' }, { operation: 'average', field: 'amount', as: 'average' },
      { operation: 'min', field: 'amount', as: 'minimum' }, { operation: 'max', field: 'amount', as: 'maximum' }, { operation: 'count', as: 'count' }] },
  ] };
}
export class WorkbookRecordCollector {
  private readonly partial = new Map<string, { kind: string; text: string; complete: boolean }>(); readonly whole: any[] = [];
  add(page: any) {
    for (const item of page.prepared_fragments) {
      if (item.kind.endsWith('-fragment')) {
        const prior = this.partial.get(item.id) ?? { kind: item.kind.slice(0, -9), text: '', complete: false };
        if (Buffer.byteLength(prior.text, 'utf8') !== item.start_byte) throw new Error('fragment gap/overlap'); prior.text += item.text; this.partial.set(item.id, prior);
        if (Buffer.byteLength(prior.text, 'utf8') !== item.end_byte) throw new Error('fragment length mismatch');
        prior.complete = item.end_byte === item.total_bytes;
      } else this.whole.push(item);
    }
  }
  records(allowPartial = false) {
    if (!allowPartial && [...this.partial.values()].some(value => !value.complete)) throw new Error('unfinished JSON record');
    const records = [...this.whole, ...[...this.partial].filter(([, value]) => value.complete).map(([id, value]) => ({ kind: value.kind, id, record: JSON.parse(value.text) }))];
    const rows = new Map<number, any>();
    for (const item of records) if (item.kind === 'table-cell') {
      let row = rows.get(item.record.firstRow);
      if (!row) { row = { kind: 'row', id: `row-${item.record.firstRow}`, record: { firstRow: item.record.firstRow, repeat: item.record.repeat, cells: Object.create(null), ...(item.record.uncertain ? { uncertain: item.record.uncertain } : {}) } }; rows.set(item.record.firstRow, row); }
      row.record.cells[item.record.field] = item.record.value;
    }
    return [...records, ...rows.values()];
  }
}
