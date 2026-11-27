import type { SaxesTagNS } from 'saxes';
import { OFFICE_NS, OFFICE_REL, type OfficeRelationship } from './OfficePackage';
import type { OfficeRecordWriter } from './OfficeInventory';
import { WORD_DRAWING_NS, WORD_PICTURE_NS } from './OfficeWordPicture';
const is = (tag: SaxesTagNS | undefined, namespaces: string[], local: string) => !!tag && namespaces.includes(tag.uri) && tag.local === local;
const plain = (tag: SaxesTagNS, name: string) => tag.attributes[name]?.value;
interface WordPictureWrapper { tag: SaxesTagNS; placement: string; geometry: Record<string, string>; id?: string; name?: string; alt?: string }
/** Streaming inventory of body pictures; numbering agrees with the fixed Word writer. */
export class OfficeWordPictures {
  pictures = 0;
  private readonly parents: SaxesTagNS[] = [];
  private readonly wrappers: WordPictureWrapper[] = [];
  private readonly active: Array<{ tag: SaxesTagNS; ordinal: number; wrapper?: WordPictureWrapper; images: Array<Record<string, unknown>>; geometry: Record<string, string>; name?: string; alt?: string }> = [];
  constructor(private readonly snapshot: string, private readonly part: string, private readonly emit: OfficeRecordWriter,
    private readonly relationships: readonly OfficeRelationship[], private readonly partRef: (name: string) => string | undefined) {}
  open(tag: SaxesTagNS) {
    if (WORD_DRAWING_NS.includes(tag.uri) && ['inline', 'anchor'].includes(tag.local)) this.wrappers.push({ tag, placement: tag.local, geometry: {} });
    const wrapper = this.wrappers.at(-1);
    if (wrapper && this.parents.at(-1) === wrapper.tag) {
      if (is(tag, WORD_DRAWING_NS, 'extent')) for (const name of ['cx', 'cy']) if (plain(tag, name) !== undefined) wrapper.geometry[name] = plain(tag, name)!;
      if (is(tag, WORD_DRAWING_NS, 'docPr')) { wrapper.id = plain(tag, 'id'); wrapper.name = plain(tag, 'name'); wrapper.alt = plain(tag, 'descr'); }
    }
    if (is(tag, WORD_PICTURE_NS, 'pic')) this.active.push({ tag, ordinal: ++this.pictures, wrapper, images: [], geometry: {} });
    const picture = this.active.at(-1);
    if (picture) {
      if (is(tag, WORD_PICTURE_NS, 'cNvPr')) { picture.name = plain(tag, 'name'); picture.alt = plain(tag, 'descr'); }
      if (is(tag, OFFICE_NS.a, 'off') || is(tag, OFFICE_NS.a, 'ext')) for (const name of ['x', 'y', 'cx', 'cy']) if (plain(tag, name) !== undefined) picture.geometry[`${tag.local}_${name}`] = plain(tag, name)!;
      if (is(tag, OFFICE_NS.a, 'blip')) {
        const embed = Object.values(tag.attributes).find(attribute => attribute.local === 'embed' && OFFICE_REL.includes(attribute.uri)); const link = Object.values(tag.attributes).find(attribute => attribute.local === 'link' && OFFICE_REL.includes(attribute.uri));
        const id = embed?.value ?? link?.value; const relation = this.relationships.find(relation => relation.id === id); const target = relation?.target ? this.partRef(relation.target) : undefined;
        if (id) picture.images.push({ relationship_id: id, linked: !!link || !!relation?.external, ...(target ? { part_ref: target } : {}) });
      }
    }
    this.parents.push(tag);
  }
  close(tag: SaxesTagNS) {
    const picture = this.active.at(-1);
    if (picture?.tag === tag) {
      const ref = `I${picture.ordinal}`; this.emit({ kind: 'object', id: ref, record: { object_ref: ref, part_ref: this.part, order: picture.ordinal, object_kind: 'pic',
        selector: { snapshot_ref: this.snapshot, object_ref: ref }, name: picture.wrapper?.name ?? picture.name ?? '', alt_text: picture.wrapper?.alt ?? picture.alt ?? '',
        placement: picture.wrapper?.placement ?? 'unresolved', geometry_emu: picture.geometry, layout_extent_emu: picture.wrapper?.geometry ?? {}, images: picture.images,
        coordinate_space: 'word-drawing-local', native_visual_check: 'not-performed' } }); this.active.pop();
    }
    if (this.wrappers.at(-1)?.tag === tag) this.wrappers.pop(); this.parents.pop();
  }
}
