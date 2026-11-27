// Read-only streaming inventory of stored main-body Word bookmark/control regions.
import type { SaxesTagNS } from 'saxes';
import { OFFICE_NS } from './OfficePackage';
import { xmlAttribute } from '../content/WorkbookXml';
import type { OfficeRecordWriter } from './OfficeInventory';
interface Region { ref: string; text: string; paragraphs: number; paragraphRefs: string[] }
interface Control extends Region { frame: SaxesTagNS; properties: Record<string, unknown> }
interface Bookmark extends Region { id?: string; name?: string; columns?: Record<string, string>; closed: boolean }
const w = (tag: SaxesTagNS | undefined, local: string) => !!tag && OFFICE_NS.w.includes(tag.uri) && tag.local === local;
export class OfficeWordRegions {
  controls = 0; bookmarks = 0;
  private readonly ancestors: SaxesTagNS[] = [];
  private readonly controlStack: Control[] = [];
  private readonly active = new Map<string, Bookmark>();
  private readonly all: Bookmark[] = [];
  private readonly paragraphStack: string[] = [];
  private paragraphCount = 0;
  constructor(private readonly snapshot: string, private readonly part: string, private readonly emit: OfficeRecordWriter) {}
  private attr(tag: SaxesTagNS, local: string) { return OFFICE_NS.w.map(uri => xmlAttribute(tag, local, uri)).find(value => value !== undefined); }
  private append(value: string) { for (const region of [...this.controlStack, ...this.active.values()]) region.text += value; }
  open(tag: SaxesTagNS) {
    const parent = this.ancestors.at(-1);
    if (w(tag, 'sdt')) this.controlStack.push({ ref: `C${++this.controls}`, text: '', paragraphs: this.paragraphStack.length ? 1 : 0, paragraphRefs: this.paragraphStack.length ? [this.paragraphStack.at(-1)!] : [], frame: tag, properties: {} });
    if (w(tag, 'bookmarkStart')) {
      const id = this.attr(tag, 'id'); const name = this.attr(tag, 'name'); const columns: Record<string, string> = {};
      for (const key of ['colFirst', 'colLast']) { const value = this.attr(tag, key); if (value !== undefined) columns[key] = value; }
      const bookmark: Bookmark = { ref: `B${++this.bookmarks}`, id, name, ...(Object.keys(columns).length ? { columns } : {}), text: '', paragraphs: this.paragraphStack.length ? 1 : 0, paragraphRefs: this.paragraphStack.length ? [this.paragraphStack.at(-1)!] : [], closed: false }; this.all.push(bookmark);
      if (id !== undefined && !this.active.has(id)) this.active.set(id, bookmark);
    }
    if (w(tag, 'bookmarkEnd')) { const id = this.attr(tag, 'id'); if (id !== undefined) { const bookmark = this.active.get(id); if (bookmark) bookmark.closed = true; this.active.delete(id); } }
    if (w(tag, 'p')) { const ref = `D${++this.paragraphCount}`; this.paragraphStack.push(ref); for (const region of [...this.controlStack, ...this.active.values()]) { if (region.paragraphs++) region.text += '\n'; region.paragraphRefs.push(ref); } }
    if (w(parent, 'r')) { if (w(tag, 'tab')) this.append('\t'); else if (w(tag, 'br') || w(tag, 'cr')) this.append('\n'); }
    const control = this.controlStack.at(-1);
    if (control && w(parent, 'sdtPr') && this.ancestors.at(-2) === control.frame) {
      if (['alias', 'tag', 'id', 'lock'].some(local => w(tag, local))) control.properties[tag.local === 'id' ? 'control_id' : tag.local] = this.attr(tag, 'val') ?? '';
      if (w(tag, 'showingPlcHdr')) control.properties.showing_placeholder = !['0', 'false', 'off'].includes(this.attr(tag, 'val')?.toLowerCase() ?? 'true');
      if (w(tag, 'dataBinding')) {
        const binding: Record<string, string> = {}; for (const key of ['storeItemID', 'xpath', 'prefixMappings']) { const value = this.attr(tag, key); if (value !== undefined) binding[key] = value; }
        control.properties.data_binding = binding; control.properties.data_binding_resolution = 'not-performed';
      }
      if (['text', 'richText', 'date', 'comboBox', 'dropDownList', 'picture', 'docPartObj', 'docPartList', 'group'].some(local => w(tag, local))) control.properties.control_type = tag.local;
    }
    this.ancestors.push(tag);
  }
  text(value: string) { if (w(this.ancestors.at(-1), 't') && w(this.ancestors.at(-2), 'r')) this.append(value); }
  close(tag: SaxesTagNS) {
    this.ancestors.pop(); if (w(tag, 'p')) this.paragraphStack.pop(); if (!w(tag, 'sdt')) return; const control = this.controlStack.pop(); if (!control) return;
    this.emit({ kind: 'content-control', id: control.ref, record: { control_ref: control.ref, part_ref: this.part, selector: { snapshot_ref: this.snapshot, control_ref: control.ref }, text: control.text,
      ...control.properties, paragraph_refs: control.paragraphRefs, content_scope: 'stored-main-body', field_refresh: 'not-performed' } });
  }
  finish() {
    for (const bookmark of this.all) this.emit({ kind: 'bookmark', id: bookmark.ref, record: { bookmark_ref: bookmark.ref, part_ref: this.part,
      selector: { snapshot_ref: this.snapshot, bookmark_ref: bookmark.ref }, ...(bookmark.id === undefined ? {} : { bookmark_id: bookmark.id }), ...(bookmark.name === undefined ? {} : { name: bookmark.name }),
      text: bookmark.text, paragraph_refs: bookmark.paragraphRefs, paired: bookmark.closed, ...(bookmark.columns ? { table_columns: bookmark.columns, table_column_resolution: 'not-performed' } : {}), content_scope: 'stored-xml-marker-span' } });
  }
}
