import { randomUUID, createHash } from 'node:crypto';
import { posix } from 'node:path';
import { opcPartName, opcRelationshipsPart } from '../content/OpcReadPackage';
import { xmlAttribute } from '../content/WorkbookXml';
import { OfficePackage, OFFICE_REL } from './OfficePackage';
import { mutateOfficeXml, officeXmlAttribute } from './OfficeXmlMutations';
import type { AddedOfficePart } from './PresentationSlideCopy';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
/** New selected-picture relationships; original shared media/relationships are never overwritten. */
export class OfficeWordMedia {
  readonly added = new Map<string, AddedOfficePart>();
  private readonly media = new Map<string, { member: string; bytes: Buffer }>();
  constructor(private readonly pkg: OfficePackage, private readonly data: Map<string, Buffer>, private readonly members: ReadonlyMap<string, { member: string }>, private readonly progress: () => void) {}
  private async read(name: string) { const current = this.data.get(name); if (current) return current; const chunks: Buffer[] = []; for await (const chunk of this.pkg.zip.bytes(name)) { this.progress(); chunks.push(Buffer.from(chunk)); } const bytes = Buffer.concat(chunks); this.data.set(name, bytes); return bytes; }
  private add(member: string, bytes: Buffer, contentType: string) { const name = opcPartName('/' + member); this.added.set(name, { member, contentType, ref: `N${this.added.size + 1}` }); this.data.set(name, bytes); return name; }
  /** v0.9.108: a new XML part beside `owner` (e.g. word/comments.xml), with its relationship from the owner and a content-type override. */
  async addRelatedPart(owner: string, fileName: string, bytes: Buffer, contentType: string, relationshipType: string) {
    const member = this.members.get(owner)!.member; const fresh = posix.join(posix.dirname(member), fileName);
    if (this.members.has(opcPartName('/' + fresh)) || this.added.has(opcPartName('/' + fresh))) throw new Error('office-part-exists');
    const name = this.add(fresh, bytes, contentType); const pending: AddedOfficePart[] = [this.added.get(name)!];
    const rels = opcRelationshipsPart(owner); const source = this.data.get(rels) ?? (this.pkg.zip.has(rels) ? await this.read(rels) : Buffer.from(`<Relationships xmlns="${PKG}"/>`)); const ids = new Set<string>();
    mutateOfficeXml(source, (tag, parents) => { if (parents.length === 1 && tag.uri === PKG && tag.local === 'Relationship') { const id = xmlAttribute(tag, 'Id'); if (id) ids.add(id); } return undefined; }, this.progress);
    let id: string; do { id = 'rId_' + randomUUID().replaceAll('-', ''); } while (ids.has(id));
    const xml = `<Relationship xmlns="${PKG}" Id="${id}" Type="${officeXmlAttribute(relationshipType)}" Target="${officeXmlAttribute(fileName)}"/>`;
    const changed = mutateOfficeXml(source, () => undefined, this.progress, { namespace: PKG, local: 'Relationships', xml });
    if (this.members.has(rels) || this.added.has(rels)) this.data.set(rels, changed); else { const relsName = this.add(posix.join(posix.dirname(member), '_rels', posix.basename(member) + '.rels'), changed, 'application/vnd.openxmlformats-package.relationships+xml'); pending.push(this.added.get(relsName)!); }
    const types = pending.map(part => `<Override xmlns="${CT}" PartName="${officeXmlAttribute('/' + part.member)}" ContentType="${officeXmlAttribute(part.contentType)}"/>`).join('');
    this.data.set('/[CONTENT_TYPES].XML', mutateOfficeXml(await this.read('/[CONTENT_TYPES].XML'), () => undefined, this.progress, { namespace: CT, local: 'Types', xml: types }));
    return name;
  }
  async addPicture(owner: string, bytes: Buffer, strict: boolean) {
    const member = this.members.get(owner)!.member; const digest = createHash('sha256').update(bytes).digest('hex'); let media = this.media.get(digest); const pending: AddedOfficePart[] = [];
    if (!media || !media.bytes.equals(bytes)) {
      let fresh: string; do { fresh = posix.join(posix.dirname(member), `unode-${randomUUID()}.png`); } while (this.members.has(opcPartName('/' + fresh)) || this.added.has(opcPartName('/' + fresh)));
      const name = this.add(fresh, bytes, 'image/png'); pending.push(this.added.get(name)!); media = { member: fresh, bytes }; this.media.set(digest, media);
    }
    const rels = opcRelationshipsPart(owner); const source = this.data.get(rels) ?? (this.pkg.zip.has(rels) ? await this.read(rels) : Buffer.from(`<Relationships xmlns="${PKG}"/>`)); const ids = new Set<string>();
    mutateOfficeXml(source, (tag, parents) => { if (parents.length === 1 && tag.uri === PKG && tag.local === 'Relationship') { const id = xmlAttribute(tag, 'Id'); if (id) ids.add(id); } return undefined; }, this.progress);
    let id: string; do { id = 'rId_' + randomUUID().replaceAll('-', ''); } while (ids.has(id));
    const target = posix.relative(posix.dirname('/' + member), '/' + media.member); const xml = `<Relationship xmlns="${PKG}" Id="${id}" Type="${OFFICE_REL[strict ? 1 : 0]}/image" Target="${officeXmlAttribute(target)}"/>`;
    const changed = mutateOfficeXml(source, () => undefined, this.progress, { namespace: PKG, local: 'Relationships', xml });
    if (this.members.has(rels) || this.added.has(rels)) this.data.set(rels, changed); else { const name = this.add(posix.join(posix.dirname(member), '_rels', posix.basename(member) + '.rels'), changed, 'application/vnd.openxmlformats-package.relationships+xml'); pending.push(this.added.get(name)!); }
    if (pending.length) { const xml = pending.map(part => `<Override xmlns="${CT}" PartName="${officeXmlAttribute('/' + part.member)}" ContentType="${officeXmlAttribute(part.contentType)}"/>`).join(''); this.data.set('/[CONTENT_TYPES].XML', mutateOfficeXml(await this.read('/[CONTENT_TYPES].XML'), () => undefined, this.progress, { namespace: CT, local: 'Types', xml })); }
    return id;
  }
}
