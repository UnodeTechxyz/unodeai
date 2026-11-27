import type { SaxesTagNS } from 'saxes';
import { OFFICE_NS, type OfficeKind } from './OfficePackage';
import { xmlAttribute } from '../content/WorkbookXml';
import type { OfficeRecordWriter } from './OfficeInventory';

interface Cell { ref: string; index: number; properties: Record<string, string>; text: string; paragraphs: number; paragraphRefs: string[]; nestedTables: string[]; embedded: boolean }
interface Table { ref: string; parentCell?: string; object?: string; rows: number; cells: number; columns: number; cellIndex: number;
  rowProperties: Record<string, string>; cell?: Cell }
/** Stored row/cell ordinals are explicit. A merged or omitted grid position is never invented as another cell. */
export class OfficeTableInventory {
  tables = 0;
  private readonly stack: Table[] = [];
  private readonly ancestors: SaxesTagNS[] = [];
  private readonly objectTables = new Map<string, number>();
  private inText = false;
  constructor(private readonly kind: OfficeKind, private readonly snapshot: string, private readonly part: string,
    private readonly emit: OfficeRecordWriter, private readonly object: () => string | undefined = () => undefined) {}
  private matches(tag: SaxesTagNS): boolean { return OFFICE_NS[this.kind === 'docx' ? 'w' : 'a'].includes(tag.uri); }
  private attr(tag: SaxesTagNS, name: string): string | undefined {
    return xmlAttribute(tag, name) ?? (this.kind === 'docx' ? OFFICE_NS.w.map(uri => xmlAttribute(tag, name, uri)).find(value => value !== undefined) : undefined);
  }
  private direct(parent: string): boolean { const tag = this.ancestors.at(-1); return !!tag && this.matches(tag) && tag.local === parent; }
  private structuralParent(parent: string): boolean {
    let index = this.ancestors.length - 1;
    if (this.kind === 'docx') {
      while (index >= 0 && this.matches(this.ancestors[index]) && ['sdt', 'sdtContent', 'customXml'].includes(this.ancestors[index].local)) index--;
    }
    const tag = this.ancestors[index]; return !!tag && this.matches(tag) && tag.local === parent;
  }
  get cellRef(): string | undefined { return this.stack.at(-1)?.cell?.ref; }
  paragraph(ref: string): void { this.stack.at(-1)?.cell?.paragraphRefs.push(ref); }
  open(tag: SaxesTagNS): void {
    if (this.matches(tag)) {
      if (tag.local === 'tbl') {
        const parent = this.stack.at(-1)?.cell; const object = this.object(); const ordinal = (this.objectTables.get(object ?? '') ?? 0) + 1;
        this.objectTables.set(object ?? '', ordinal); const ref = object ? `${object}-T${ordinal}` : `T${this.tables + 1}`; this.tables++;
        parent?.nestedTables.push(ref); this.stack.push({ ref, parentCell: parent?.ref, object, rows: 0, cells: 0, columns: 0, cellIndex: 0, rowProperties: {} });
      }
      const table = this.stack.at(-1);
      if (table) {
        if (tag.local === 'gridCol' && this.direct('tblGrid')) {
          table.columns++; this.emit({ kind: 'table-column', id: `${table.ref}-G${table.columns}`, record: { table_ref: table.ref, column_index: table.columns,
            ...(this.attr(tag, 'w') !== undefined ? { saved_width: this.attr(tag, 'w') } : {}) } });
        }
        if (tag.local === 'tr' && this.structuralParent('tbl')) { table.rows++; table.cellIndex = 0; table.rowProperties = {};
          const height = this.attr(tag, 'h'); if (height !== undefined) table.rowProperties.height = height; }
        if (tag.local === 'tc' && this.structuralParent('tr')) {
          const index = ++table.cellIndex; table.cells++; table.cell = { ref: `${table.ref}-R${table.rows}-C${index}`, index,
            properties: {}, text: '', paragraphs: 0, paragraphRefs: [], nestedTables: [], embedded: false };
          if (this.kind === 'pptx') for (const name of ['gridSpan', 'rowSpan', 'hMerge', 'vMerge']) {
            const value = this.attr(tag, name); if (value !== undefined) table.cell.properties[name] = value;
          }
        }
        if (this.kind === 'docx' && this.direct('trPr') && ['gridBefore', 'gridAfter', 'tblHeader'].includes(tag.local)) table.rowProperties[tag.local] = this.attr(tag, 'val') ?? 'true';
        if (this.kind === 'docx' && table.cell && this.direct('tcPr') && ['gridSpan', 'vMerge', 'hMerge'].includes(tag.local)) {
          table.cell.properties[tag.local] = this.attr(tag, 'val') ?? (tag.local === 'gridSpan' ? 'missing-value' : 'continue');
        }
        const cell = table.cell;
        if (cell) {
          if (tag.local === 'p') { if (cell.paragraphs++) cell.text += '\n'; }
          const run = this.direct('r');
          if (tag.local === 't' && (run || (this.kind === 'pptx' && this.direct('fld')))) this.inText = true;
          if (tag.local === 'tab' && run) cell.text += '\t';
          if ((tag.local === 'br' || tag.local === 'cr') && (run || (this.kind === 'pptx' && this.direct('p')))) cell.text += '\n';
          if (['drawing', 'object', 'blip'].includes(tag.local)) cell.embedded = true;
        }
      }
    }
    this.ancestors.push(tag);
  }
  text(value: string): void { const cell = this.stack.at(-1)?.cell; if (cell && this.inText) cell.text += value; }
  close(tag: SaxesTagNS): void {
    this.ancestors.pop(); const table = this.stack.at(-1); if (!table || !this.matches(tag)) return;
    if (tag.local === 't') this.inText = false;
    if (tag.local === 'tc' && this.structuralParent('tr') && table.cell) {
      const cell = table.cell; this.emit({ kind: 'table-cell', id: cell.ref, record: { cell_ref: cell.ref, table_ref: table.ref, part_ref: this.part,
        row_index: table.rows, cell_index: cell.index, coordinate_system: 'stored-row-cell-ordinals',
        selector: { snapshot_ref: this.snapshot, cell_ref: cell.ref }, text: cell.text, saved_merge_properties: cell.properties,
        paragraph_refs: cell.paragraphRefs, nested_table_refs: cell.nestedTables, embedded_content_present: cell.embedded,
        visual_check: 'not-performed' } }); table.cell = undefined;
    }
    if (tag.local === 'tr' && this.structuralParent('tbl')) this.emit({ kind: 'table-row', id: `${table.ref}-R${table.rows}`, record: { table_ref: table.ref, row_index: table.rows,
      stored_cells: table.cellIndex, saved_properties: table.rowProperties } });
    if (tag.local === 'tbl') { this.stack.pop(); this.emit({ kind: 'table', id: table.ref, record: { table_ref: table.ref, part_ref: this.part,
      ...(table.object ? { object_ref: table.object } : {}), ...(table.parentCell ? { parent_cell: table.parentCell } : {}), rows: table.rows, stored_cells: table.cells,
      grid_columns: table.columns, coordinate_system: 'stored-row-cell-ordinals', cell_mapping: 'stored-rows-and-cells',
      selector: { snapshot_ref: this.snapshot, table_ref: table.ref }, native_grid_layout: 'not-resolved' } }); }
  }
}
