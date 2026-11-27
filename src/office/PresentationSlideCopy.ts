import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { OfficePackage, OFFICE_NS, OFFICE_REL } from './OfficePackage';
import { opcPartName, opcRelationshipsPart } from '../content/OpcReadPackage';
import { xmlAttribute } from '../content/WorkbookXml';
import { mutateOfficeXml, officeXmlAttribute } from './OfficeXmlMutations';
import { OfficeEditFailure } from './OfficeEditContracts';
import type { SaxesTagNS } from 'saxes';
import { cloneOfficeSlideGraph, currentOfficeRelationships, unreferencedOfficeOwnedParts } from './OfficePartCloner';
import { duplicatePresentationEntry, presentationApplicationCount } from './PresentationSlideList';
import { removePresentationEntry } from './PresentationSlideRemove';
import { officeXmlElements, removeOfficeElements } from './OfficeXmlElements';
import { importOfficeDonorGraph } from './OfficeDonorGraph';
import { appendPresentationList, insertPresentationDonorEntry } from './PresentationDonorEntry';
import { presentationApplicationTitles } from './PresentationApplicationTitles';

const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const CHART = ['http://schemas.openxmlformats.org/drawingml/2006/chart', 'http://purl.oclc.org/ooxml/drawingml/chart'];
const p = (tag: SaxesTagNS | undefined, local: string) => !!tag && OFFICE_NS.p.includes(tag.uri) && tag.local === local;
const relationId = (tag: SaxesTagNS) => Object.values(tag.attributes).find(attribute => attribute.local === 'id' && OFFICE_REL.includes(attribute.uri));
interface Use { ref: string; order: number; rid: string; relationshipType: string; source: string; part: string; originalOrder?: number }
export interface AddedOfficePart { member: string; ref: string; contentType: string }
const fail = (): never => { throw new OfficeEditFailure('unsupported-package-preservation'); };

/** Preserving slide ownership and dependency copies; logical entries retain their original snapshot selectors. */
export class PresentationSlideCopy {
  readonly added = new Map<string, AddedOfficePart>();
  private readonly uses = new Map<string, Use>();
  private readonly owners = new Map<string, Set<string>>();
  private readonly relationshipOwners = new Map<string, Set<string>>();
  private readonly ids = new Set<string>();
  private readonly slideIds = new Set<string>();
  private readonly registered = new Set<string>();
  private duplicateOrdinal = 0;
  private addedOrdinal = 0;
  readonly removed = new Set<string>();
  private readonly removedRoots = new Set<string>();
  private firstSource?: string;
  private constructor(private readonly pkg: OfficePackage, private readonly data: Map<string, Buffer>,
    private readonly members: ReadonlyMap<string, { member: string }>, private readonly progress: () => void) {}

  static async create(pkg: OfficePackage, data: Map<string, Buffer>, members: ReadonlyMap<string, { member: string }>, progress: () => void) {
    const copy = new PresentationSlideCopy(pkg, data, members, progress); const relationships = await pkg.relations(pkg.main.name);
    for (const relationship of relationships) copy.ids.add(relationship.id);
    const parents: SaxesTagNS[] = []; let order = 0;
    await pkg.zip.xml(pkg.main.name, { open(tag) {
      if (parents.length === 2 && p(parents[0], 'presentation') && p(parents[1], 'sldIdLst') && p(tag, 'sldId')) {
        const numericId = xmlAttribute(tag, 'id'); if (numericId && /^\d+$/.test(numericId)) copy.slideIds.add(String(BigInt(numericId)));
        const ref = `S${++order}`; const rid = relationId(tag)?.value;
        const relation = relationships.find(relation => relation.id === rid && relation.kind === 'slide' && !relation.external && relation.target);
        if (rid && relation?.target && pkg.part(relation.target)) {
          copy.uses.set(ref, { ref, order, originalOrder: order, rid, relationshipType: relation.type, source: relation.target, part: relation.target });
          if (order === 1) copy.firstSource = relation.target;
          const owners = copy.owners.get(relation.target) ?? new Set<string>(); owners.add(ref); copy.owners.set(relation.target, owners);
          const refs = copy.relationshipOwners.get(rid) ?? new Set<string>(); refs.add(ref); copy.relationshipOwners.set(rid, refs);
        }
      }
      parents.push(tag);
    }, close() { parents.pop(); } });
    return copy;
  }

  private async read(name: string): Promise<Buffer> {
    const old = this.data.get(name); if (old) return old;
    const chunks: Buffer[] = []; for await (const chunk of this.pkg.zip.bytes(name)) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks); this.data.set(name, bytes); return bytes;
  }
  private member(name: string): string { return this.added.get(name)?.member ?? this.members.get(name)?.member ?? fail(); }
  private fresh(name: string, extension?: string): string {
    const original = this.member(name);
    for (;;) {
      const member = posix.join(posix.dirname(original), `unode-${randomUUID()}${extension ?? (posix.extname(original) || '.xml')}`);
      const key = opcPartName('/' + member); const rels = opcRelationshipsPart('/' + member);
      if (!this.members.has(key) && !this.added.has(key) && !this.members.has(rels) && !this.added.has(rels)) return member;
    }
  }
  private add(member: string, bytes: Buffer, contentType: string): string {
    const key = opcPartName('/' + member); if (this.members.has(key) || this.added.has(key)) return fail();
    this.added.set(key, { member, contentType, ref: `N${++this.addedOrdinal}` }); this.data.set(key, bytes); return key;
  }
  private relative(fromMember: string, toMember: string): string { return posix.relative(posix.dirname('/' + fromMember), '/' + toMember); }

  private rewriteRelationships(bytes: Buffer, targets: Map<string, string>): Buffer {
    if (!targets.size) return bytes; const found = new Set<string>();
    const changed = mutateOfficeXml(bytes, (tag, parents) => {
      if (parents.length !== 1 || parents[0].uri !== PKG || parents[0].local !== 'Relationships' || tag.uri !== PKG || tag.local !== 'Relationship') return;
      const id = xmlAttribute(tag, 'Id'); if (!id || !targets.has(id)) return;
      found.add(id); return { name: 'Target', value: targets.get(id)! };
    }, this.progress);
    if (found.size !== targets.size) return fail(); return changed;
  }
  private async cloneRelationships(source: string, member: string, targets: Map<string, string>): Promise<void> {
    const name = opcRelationshipsPart(source); if (!this.pkg.zip.has(name)) { if (targets.size) return fail(); return; }
    const target = posix.join(posix.dirname(member), '_rels', posix.basename(member) + '.rels');
    this.add(target, this.rewriteRelationships(await this.read(name), targets), 'application/vnd.openxmlformats-package.relationships+xml');
  }
  private async registerParts(): Promise<void> {
    const pending = [...this.added].filter(([name]) => !this.registered.has(name)); if (!pending.length) return;
    const xml = pending.map(([, part]) => `<Override xmlns="${CT}" PartName="${officeXmlAttribute('/' + part.member)}" ContentType="${officeXmlAttribute(part.contentType)}"/>`).join('');
    this.data.set('/[CONTENT_TYPES].XML', mutateOfficeXml(await this.read('/[CONTENT_TYPES].XML'), () => undefined, this.progress, { namespace: CT, local: 'Types', xml }));
    for (const [name] of pending) this.registered.add(name);
  }

  currentPart(slideRef: string, originalPart: string): string {
    const use = this.uses.get(slideRef); if (!use || use.source !== originalPart) throw new OfficeEditFailure('edit-target-unavailable'); return use.part;
  }

  async verifySlideList(output: OfficePackage, expectedCount: number): Promise<void> {
    const relations = await output.relations(output.main.name); const parents: SaxesTagNS[] = []; let order = 0;
    const uses = new Map([...this.uses.values()].map(use => [use.order, use]));
    await output.zip.xml(output.main.name, { open(tag) {
      if (parents.length === 2 && p(parents[0], 'presentation') && p(parents[1], 'sldIdLst') && p(tag, 'sldId')) {
        const use = uses.get(++order);
        if (use) {
          const rid = relationId(tag)?.value; const relation = relations.find(relation => relation.id === rid);
          if (rid !== use.rid || !relation || relation.external || relation.kind !== 'slide' || relation.target !== use.part || !output.part(use.part)) throw new OfficeEditFailure('office-output-check-failed');
        }
      }
      parents.push(tag);
    }, close() { parents.pop(); } });
    if (order !== expectedCount || [...uses.keys()].some(order => order > expectedCount)) throw new OfficeEditFailure('office-output-check-failed');
  }

  async duplicate(slideRef: string, originalPart: string, afterRef: string | null) {
    const source = this.uses.get(slideRef); if (!source || source.source !== originalPart) throw new OfficeEditFailure('edit-target-unavailable');
    const anchor = afterRef === null ? undefined : this.uses.get(afterRef); if (afterRef !== null && !anchor) throw new OfficeEditFailure('edit-target-unavailable');
    let rid: string; do { rid = 'rId_' + randomUUID().replaceAll('-', ''); } while (this.ids.has(rid));
    const inserted = duplicatePresentationEntry(await this.read(this.pkg.main.name), source.order, source.rid, anchor?.order ?? 0, rid, this.progress, this.slideIds);
    this.slideIds.add(inserted.id);
    const cloned = await cloneOfficeSlideGraph({ read: name => this.read(name), member: name => this.member(name),
      has: name => this.members.has(name) || this.added.has(name), contentType: name => this.added.get(name)?.contentType ?? this.pkg.part(name)?.contentType,
      add: (member, bytes, contentType) => this.add(member, bytes, contentType) }, source.part, this.pkg.main.name, this.progress);
    this.ids.add(rid); const ref = `duplicate-${++this.duplicateOrdinal}`;
    for (const use of this.uses.values()) if (use.order >= inserted.order) use.order++;
    this.uses.set(ref, { ref, order: inserted.order, originalOrder: source.originalOrder, rid, relationshipType: source.relationshipType, source: source.source, part: cloned.root });
    this.owners.set(cloned.root, new Set([ref])); this.relationshipOwners.set(rid, new Set([ref])); this.data.set(this.pkg.main.name, inserted.bytes);
    const mainRels = opcRelationshipsPart(this.pkg.main.name); const xml = `<Relationship xmlns="${PKG}" Id="${rid}" Type="${officeXmlAttribute(source.relationshipType)}" Target="${officeXmlAttribute(this.relative(this.member(this.pkg.main.name), this.member(cloned.root)))}"/>`;
    this.data.set(mainRels, mutateOfficeXml(await this.read(mainRels), () => undefined, this.progress, { namespace: PKG, local: 'Relationships', xml }));
    await this.registerParts();
    const properties = (await this.pkg.relations('/')).filter(relation => relation.kind === 'extended-properties' && !relation.external && relation.target && this.pkg.part(relation.target));
    let metadataUnavailable = properties.length > 1;
    if (properties.length === 1) {
      const name = properties[0].target!;
      try { this.data.set(name, presentationApplicationCount(await this.read(name), inserted.after, this.progress)); }
      catch { metadataUnavailable = true; }
    }
    return { target_ref: slideRef, new_slide_id: inserted.id, before: inserted.before, after: inserted.after, order: inserted.order,
      unavailable_dependencies: cloned.unavailable, unknown_content_types: cloned.unknownTypes, metadata_unavailable: metadataUnavailable };
  }

  async remove(slideRef: string, originalPart: string) {
    const source = this.uses.get(slideRef); if (!source || source.source !== originalPart) throw new OfficeEditFailure('edit-target-unavailable');
    const result = removePresentationEntry(await this.read(this.pkg.main.name), source.order, source.rid, this.progress);
    this.data.set(this.pkg.main.name, result.bytes); this.uses.delete(slideRef); this.owners.get(source.part)?.delete(slideRef); this.relationshipOwners.get(source.rid)?.delete(slideRef);
    for (const use of this.uses.values()) if (use.order > source.order) use.order--;
    if (result.retireRelationship) {
      const name = opcRelationshipsPart(this.pkg.main.name); const parsed = officeXmlElements(await this.read(name), this.progress);
      this.data.set(name, removeOfficeElements(parsed, parsed.elements.filter(element => element.tag.uri === PKG && element.tag.local === 'Relationship' && xmlAttribute(element.tag, 'Id') === source.rid)));
    }
    this.removedRoots.add(source.part);
    return { target_ref: slideRef, before: result.before, after: result.after, order: result.order, auxiliary_references: result.auxiliary,
      ...(result.id === undefined ? {} : { removed_slide_id: result.id }) };
  }

  async insertDonor(donor: OfficePackage, donorPart: string, afterRef: string | null | undefined) {
    const anchor = afterRef ? this.uses.get(afterRef) : undefined; if (afterRef && !anchor) throw new OfficeEditFailure('edit-target-unavailable');
    const after = afterRef === null ? 0 : anchor?.order ?? Math.max(0, ...[...this.uses.values()].map(use => use.order));
    let rid: string; do { rid = 'rId_' + randomUUID().replaceAll('-', ''); } while (this.ids.has(rid));
    const inserted = insertPresentationDonorEntry(await this.read(this.pkg.main.name), rid, after, this.slideIds, this.progress); this.slideIds.add(inserted.id); this.ids.add(rid);
    const cloned = await importOfficeDonorGraph(donor, donorPart, { read: name => this.read(name), member: name => this.member(name),
      has: name => this.members.has(opcPartName(name)) || this.added.has(opcPartName(name)), contentType: name => this.added.get(name)?.contentType ?? this.pkg.part(name)?.contentType,
      add: (member, bytes, type) => this.add(member, bytes, type) }, this.pkg.main.name, this.progress);
    const ref = `inserted-${++this.duplicateOrdinal}`;
    for (const use of this.uses.values()) if (use.order >= inserted.order) use.order++;
    this.uses.set(ref, { ref, order: inserted.order, rid, relationshipType: inserted.relationshipBase + '/slide', source: cloned.root, part: cloned.root });
    this.owners.set(cloned.root, new Set([ref])); this.relationshipOwners.set(rid, new Set([ref])); this.data.set(this.pkg.main.name, inserted.bytes);
    const addMainRelationship = async (relationship: string, kind: string, target: string) => {
      const xml = `<Relationship xmlns="${PKG}" Id="${relationship}" Type="${inserted.relationshipBase}/${kind}" Target="${officeXmlAttribute(this.relative(this.member(this.pkg.main.name), this.member(target)))}"/>`;
      const rels = opcRelationshipsPart(this.pkg.main.name); this.data.set(rels, mutateOfficeXml(await this.read(rels), () => undefined, this.progress, { namespace: PKG, local: 'Relationships', xml }));
    };
    await addMainRelationship(rid, 'slide', cloned.root);
    const numeric = new Set<string>();
    for (const part of [...this.pkg.parts, ...[...this.added].map(([name, part]) => ({ name, contentType: part.contentType }))]) {
      if (part.name !== this.pkg.main.name && !part.contentType?.endsWith('presentationml.slideMaster+xml')) continue;
      for (const element of officeXmlElements(await this.read(part.name), this.progress).elements) if (p(element.tag, 'sldMasterId') || p(element.tag, 'sldLayoutId')) {
        const id = xmlAttribute(element.tag, 'id'); if (id && /^\d+$/.test(id)) numeric.add(String(BigInt(id)));
      }
    }
    const next = () => { let id = 2147483648n; while (numeric.has(String(id))) id++; if (id > 4294967295n) return fail(); numeric.add(String(id)); return String(id); };
    for (const master of cloned.kinds.get('slideMaster') ?? []) {
      this.data.set(master, mutateOfficeXml(await this.read(master), (tag, parents) => p(tag, 'sldLayoutId') && parents.length === 2 && p(parents[1], 'sldLayoutIdLst') ? { name: 'id', value: next() } : undefined, this.progress));
      let relationship: string; do { relationship = 'rId_' + randomUUID().replaceAll('-', ''); } while (this.ids.has(relationship)); this.ids.add(relationship);
      await addMainRelationship(relationship, 'slideMaster', master);
      this.data.set(this.pkg.main.name, appendPresentationList(await this.read(this.pkg.main.name), 'sldMasterIdLst', `<oi:sldMasterId xmlns:oi="${inserted.presentationNamespace}" xmlns:or="${inserted.relationshipBase}" id="${next()}" or:id="${relationship}"/>`, this.progress));
    }
    // A presentation has one primary notes master. Keep it; donor notes retain their own copied master relationships.
    const main = officeXmlElements(await this.read(this.pkg.main.name), this.progress); const notesList = main.elements[0].children.find(element => p(element.tag, 'notesMasterIdLst'));
    const firstNotes = [...cloned.kinds.get('notesMaster') ?? []][0];
    if (firstNotes && !notesList?.children.some(element => p(element.tag, 'notesMasterId'))) {
      const relationship = 'rId_' + randomUUID().replaceAll('-', ''); this.ids.add(relationship); await addMainRelationship(relationship, 'notesMaster', firstNotes);
      this.data.set(this.pkg.main.name, appendPresentationList(await this.read(this.pkg.main.name), 'notesMasterIdLst', `<oi:notesMasterId xmlns:oi="${main.elements[0].tag.uri}" xmlns:or="${inserted.relationshipBase}" or:id="${relationship}"/>`, this.progress));
    }
    await this.registerParts();
    const properties = (await this.pkg.relations('/')).filter(relation => relation.kind === 'extended-properties' && !relation.external && relation.target && this.pkg.part(relation.target));
    let metadataUnavailable = properties.length > 1;
    if (properties.length === 1) { try { this.data.set(properties[0].target!, presentationApplicationCount(await this.read(properties[0].target!), inserted.after, this.progress)); } catch { metadataUnavailable = true; } }
    return { new_slide_id: inserted.id, before: inserted.before, after: inserted.after, order: inserted.order, unavailable_dependencies: cloned.unavailable,
      unknown_content_types: cloned.unknownTypes, metadata_unavailable: metadataUnavailable, auxiliary_slides: cloned.auxiliarySlides };
  }

  private async removeRetiredSlideHyperlinks() {
    const retired = new Set([...this.removedRoots].filter(root => ![...this.uses.values()].some(use => use.part === root)));
    for (const owner of [...this.members.keys(), ...this.added.keys()]) {
      if (!/\.XML$/i.test(owner) || this.removedRoots.has(owner)) continue;
      const rels = opcRelationshipsPart(owner); if (!this.members.has(rels) && !this.added.has(rels)) continue;
      const relations = await currentOfficeRelationships(await this.read(rels), owner, this.progress);
      const ids = new Set(relations.filter(relation => relation.kind === 'slide' && !relation.external && relation.target && retired.has(relation.target)).map(relation => relation.id)); if (!ids.size) continue;
      const xml = officeXmlElements(await this.read(owner), this.progress);
      const links = xml.elements.filter(element => OFFICE_NS.a.includes(element.tag.uri) && ['hlinkClick', 'hlinkHover', 'hlinkMouseOver'].includes(element.tag.local) && ids.has(relationId(element.tag)?.value ?? ''));
      const removable = new Set(links.map(link => relationId(link.tag)!.value));
      for (const element of xml.elements) if (!links.includes(element)) for (const attribute of Object.values(element.tag.attributes)) if (OFFICE_REL.includes(attribute.uri)) removable.delete(attribute.value);
      if (!removable.size) continue;
      this.data.set(owner, removeOfficeElements(xml, links.filter(link => removable.has(relationId(link.tag)!.value))));
      const parsed = officeXmlElements(await this.read(rels), this.progress);
      this.data.set(rels, removeOfficeElements(parsed, parsed.elements.filter(element => element.tag.uri === PKG && element.tag.local === 'Relationship' && removable.has(xmlAttribute(element.tag, 'Id') ?? ''))));
    }
  }

  async finishRemovals(expectedCount: number) {
    if (!this.removedRoots.size) return { retained: 0 };
    await this.removeRetiredSlideHyperlinks();
    const result = await unreferencedOfficeOwnedParts({ read: name => this.read(name), member: name => this.member(name),
      has: name => this.members.has(name) || this.added.has(name), contentType: name => this.added.get(name)?.contentType ?? this.pkg.part(name)?.contentType,
      add: (member, bytes, type) => this.add(member, bytes, type), names: () => [...this.members.keys(), ...this.added.keys()] }, this.removedRoots, this.pkg.main.name, this.progress);
    for (const name of result.removed) { this.data.delete(name); if (this.added.has(name)) this.added.delete(name); else this.removed.add(name); }
    const types = officeXmlElements(await this.read('/[CONTENT_TYPES].XML'), this.progress);
    this.data.set('/[CONTENT_TYPES].XML', removeOfficeElements(types, types.elements.filter(element => element.tag.uri === CT && element.tag.local === 'Override'
      && result.removed.has(opcPartName(xmlAttribute(element.tag, 'PartName') ?? '/invalid')))));
    const properties = (await this.pkg.relations('/')).filter(relation => relation.kind === 'extended-properties' && !relation.external && relation.target && this.pkg.part(relation.target));
    let metadataUnavailable = properties.length > 1;
    if (properties.length === 1) {
      try { this.data.set(properties[0].target!, presentationApplicationTitles(presentationApplicationCount(await this.read(properties[0].target!), expectedCount, this.progress),
        [...this.uses.values()].sort((a, b) => a.order - b.order).map(use => use.originalOrder), this.progress)); }
      catch { metadataUnavailable = true; }
    }
    return { retained: result.retained, metadataUnavailable };
  }

  /** A cached first-page preview must not survive a change to that page or one of its render dependencies. */
  async dropStaleThumbnail(): Promise<string[]> {
    const thumbnails = (await this.pkg.relations('/')).filter(relation => relation.type === 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail');
    if (!thumbnails.length) return [];
    const first = [...this.uses.values()].sort((a, b) => a.order - b.order)[0];
    let changed = first?.source !== this.firstSource;
    const readOriginal = async (name: string) => { const chunks: Buffer[] = []; for await (const chunk of this.pkg.zip.bytes(name)) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); };
    const queue = first ? [first.part] : []; const seen = new Set<string>();
    for (let at = 0; !changed && at < queue.length; at++) {
      const name = queue[at]; if (seen.has(name) || name === this.pkg.main.name) continue; seen.add(name);
      if (!this.pkg.zip.has(name) || this.data.has(name) && !this.data.get(name)!.equals(await readOriginal(name))) { changed = true; break; }
      const rels = opcRelationshipsPart(name);
      if (!this.members.has(rels) && !this.added.has(rels)) continue;
      const bytes = await this.read(rels);
      if (!this.pkg.zip.has(rels) || !bytes.equals(await readOriginal(rels))) { changed = true; break; }
      for (const relation of await currentOfficeRelationships(bytes, name, this.progress)) if (!relation.external && relation.target && relation.kind !== 'slide'
        && relation.target !== this.pkg.main.name && (this.members.has(relation.target) || this.added.has(relation.target))) queue.push(relation.target);
    }
    if (!changed) return [];
    const rels = opcRelationshipsPart('/'); const parsed = officeXmlElements(await this.read(rels), this.progress); const ids = new Set(thumbnails.map(relation => relation.id));
    this.data.set(rels, removeOfficeElements(parsed, parsed.elements.filter(element => element.tag.uri === PKG && element.tag.local === 'Relationship' && ids.has(xmlAttribute(element.tag, 'Id') ?? ''))));
    const roots = new Set(thumbnails.flatMap(relation => !relation.external && relation.target && this.members.has(relation.target) ? [relation.target] : []));
    const owned = await unreferencedOfficeOwnedParts({ read: name => this.read(name), member: name => this.member(name),
      has: name => !this.removed.has(name) && (this.members.has(name) || this.added.has(name)), contentType: name => this.added.get(name)?.contentType ?? this.pkg.part(name)?.contentType,
      add: (member, bytes, type) => this.add(member, bytes, type), names: () => [...this.members.keys(), ...this.added.keys()].filter(name => !this.removed.has(name)) }, roots, this.pkg.main.name, this.progress);
    const allowed = new Set([...roots, ...[...roots].map(opcRelationshipsPart)]);
    const removed: string[] = [];
    for (const name of owned.removed) if (allowed.has(name)) { this.removed.add(name); this.data.delete(name); removed.push(name); }
    if (removed.length) {
      const types = officeXmlElements(await this.read('/[CONTENT_TYPES].XML'), this.progress);
      this.data.set('/[CONTENT_TYPES].XML', removeOfficeElements(types, types.elements.filter(element => element.tag.uri === CT && element.tag.local === 'Override'
        && this.removed.has(opcPartName(xmlAttribute(element.tag, 'PartName') ?? '/invalid')))));
    }
    return removed;
  }

  async addPicture(slideRef: string, originalPart: string, bytes: Buffer): Promise<{ part: string; relationship: string }> {
    const part = await this.isolate(slideRef, originalPart); const member = this.member(part);
    const media = this.fresh(part, '.png'); this.add(media, bytes, 'image/png');
    const rels = opcRelationshipsPart(part); const ids = new Set<string>();
    const source = this.data.get(rels) ?? (this.pkg.zip.has(rels) ? await this.read(rels) : Buffer.from(`<Relationships xmlns="${PKG}"></Relationships>`));
    mutateOfficeXml(source, tag => { if (tag.uri === PKG && tag.local === 'Relationship') { const id = xmlAttribute(tag, 'Id'); if (id) ids.add(id); } return undefined; }, this.progress);
    let relationship: string; do { relationship = `rId_${randomUUID().replaceAll('-', '')}`; } while (ids.has(relationship));
    const type = (await this.pkg.relations(originalPart)).find(relation => relation.kind === 'image')?.type ?? `${OFFICE_REL[0]}/image`;
    const xml = `<Relationship xmlns="${PKG}" Id="${relationship}" Type="${officeXmlAttribute(type)}" Target="${officeXmlAttribute(this.relative(member, media))}"/>`;
    const changed = mutateOfficeXml(source, () => undefined, this.progress, { namespace: PKG, local: 'Relationships', xml });
    if (this.members.has(rels) || this.added.has(rels)) this.data.set(rels, changed);
    else this.add(posix.join(posix.dirname(member), '_rels', posix.basename(member) + '.rels'), changed, 'application/vnd.openxmlformats-package.relationships+xml');
    await this.registerParts(); return { part, relationship };
  }

  async addChart(slideRef: string, originalPart: string, chartId: string, workbook: Buffer, build: (packageId: string) => Buffer): Promise<{ part: string; relationship: string; chart: string }> {
    const relation = (await this.pkg.relations(originalPart)).find(relation => relation.id === chartId && relation.kind === 'chart' && !relation.external && relation.target && this.pkg.part(relation.target));
    if (!relation?.target) throw new OfficeEditFailure('edit-target-unavailable');
    const chart = relation.target; const chartMember = this.fresh(chart); const workbookMember = this.fresh(chart, '.xlsx');
    this.add(workbookMember, workbook, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const chartRelationships = await this.pkg.relations(chart); const packageIds = new Set(chartRelationships.map(relation => relation.id));
    let packageId: string; do { packageId = 'rId_' + randomUUID().replaceAll('-', ''); } while (packageIds.has(packageId));
    const added = this.add(chartMember, build(packageId), this.pkg.part(chart)?.contentType ?? 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml');
    const rels = opcRelationshipsPart(chart); const original = this.pkg.zip.has(rels) ? await this.read(rels) : Buffer.from(`<Relationships xmlns="${PKG}"/>`);
    const relType = chartRelationships.find(relation => relation.kind === 'package')?.type ?? `${relation.type.slice(0, relation.type.lastIndexOf('/'))}/package`;
    const addedRelationship = `<Relationship xmlns="${PKG}" Id="${packageId}" Type="${officeXmlAttribute(relType)}" Target="${officeXmlAttribute(this.relative(chartMember, workbookMember))}"/>`;
    this.add(posix.join(posix.dirname(chartMember), '_rels', posix.basename(chartMember) + '.rels'),
      mutateOfficeXml(original, () => undefined, this.progress, { namespace: PKG, local: 'Relationships', xml: addedRelationship }), 'application/vnd.openxmlformats-package.relationships+xml');
    return { ...await this.relateChart(slideRef, originalPart, relation.type, chartMember), chart: added };
  }

  /** Isolate the slide and give it a new relationship to an added chart member. */
  private async relateChart(slideRef: string, originalPart: string, type: string, chartMember: string): Promise<{ part: string; relationship: string }> {
    const part = await this.isolate(slideRef, originalPart); const member = this.member(part); const slideRels = opcRelationshipsPart(part);
    const current = this.data.get(slideRels) ?? await this.read(slideRels); const ids = new Set<string>();
    mutateOfficeXml(current, tag => { if (tag.uri === PKG && tag.local === 'Relationship') { const id = xmlAttribute(tag, 'Id'); if (id) ids.add(id); } return undefined; }, this.progress);
    let relationship: string; do { relationship = 'rId_' + randomUUID().replaceAll('-', ''); } while (ids.has(relationship));
    const xml = `<Relationship xmlns="${PKG}" Id="${relationship}" Type="${officeXmlAttribute(type)}" Target="${officeXmlAttribute(this.relative(member, chartMember))}"/>`;
    this.data.set(slideRels, mutateOfficeXml(current, () => undefined, this.progress, { namespace: PKG, local: 'Relationships', xml }));
    await this.registerParts(); return { part, relationship };
  }

  /**
   * True when the selected slide's chart relationship is the package's only reference to this chart part, the slide is
   * not shared by another slide entry, and exactly one chart frame on it uses that relationship: then the chart part
   * may be edited in place. Otherwise an edit must use its own copy.
   */
  async chartExclusive(slideRef: string, originalPart: string, chartId: string, chart: string): Promise<boolean> {
    const use = this.uses.get(slideRef); if (!use || use.source !== originalPart) throw new OfficeEditFailure('edit-target-unavailable');
    if (use.part !== use.source || this.owners.get(use.part)?.size !== 1) return false;
    let references = 0;
    const owners = new Set(['/', ...[...this.pkg.zip.names(), ...this.added.keys()].filter(name => !/\/_RELS\/[^/]*\.RELS$/i.test(name) && !this.removed.has(name))]);
    for (const owner of owners) {
      const rels = opcRelationshipsPart(owner); if (!this.data.has(rels) && !this.pkg.zip.has(rels)) continue;
      for (const relation of await currentOfficeRelationships(await this.read(rels), owner, this.progress)) if (!relation.external && relation.target === chart) references++;
      this.progress();
    }
    if (references !== 1) return false;
    let frames = 0;
    mutateOfficeXml(await this.read(use.part), tag => {
      if (CHART.includes(tag.uri) && tag.local === 'chart' && relationId(tag)?.value === chartId) frames++; return undefined;
    }, this.progress);
    return frames === 1;
  }

  /** A same-folder copy of a shared chart part for this slide. Its own relationships (embedded workbook, styles, drawings) stay shared. */
  async copyChart(slideRef: string, originalPart: string, chartId: string, bytes: Buffer): Promise<{ part: string; relationship: string; chart: string }> {
    const relation = (await this.pkg.relations(originalPart)).find(relation => relation.id === chartId && relation.kind === 'chart' && !relation.external && relation.target && this.pkg.part(relation.target));
    if (!relation?.target) throw new OfficeEditFailure('edit-target-unavailable');
    const chartMember = this.fresh(relation.target);
    const chart = this.add(chartMember, bytes, this.pkg.part(relation.target)?.contentType ?? 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml');
    await this.cloneRelationships(relation.target, chartMember, new Map());
    return { ...await this.relateChart(slideRef, originalPart, relation.type, chartMember), chart };
  }

  async isolate(slideRef: string, originalPart: string): Promise<string> {
    const use = this.uses.get(slideRef); if (!use || use.source !== originalPart) throw new OfficeEditFailure('edit-target-unavailable');
    const owners = this.owners.get(use.part)!; if (owners.size === 1) return use.part;
    const old = use.part; const member = this.fresh(old); const name = this.add(member, await this.read(old), this.pkg.part(old)?.contentType ?? 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml');
    const slideTargets = new Map<string, string>(); const notesCopies = new Map<string, string>();
    for (const relation of await this.pkg.relations(old)) {
      if (relation.kind !== 'notesSlide' || relation.external || !relation.target || !this.pkg.part(relation.target)) continue;
      let notes = notesCopies.get(relation.target);
      if (!notes) {
        const notesMember = this.fresh(relation.target);
        notes = this.add(notesMember, await this.read(relation.target), this.pkg.part(relation.target)?.contentType ?? 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml');
        const backlinks = new Map<string, string>();
        for (const back of await this.pkg.relations(relation.target)) if (back.kind === 'slide' && !back.external && back.target === old) backlinks.set(back.id, this.relative(notesMember, member));
        await this.cloneRelationships(relation.target, notesMember, backlinks); notesCopies.set(relation.target, notes);
      }
      slideTargets.set(relation.id, this.relative(member, this.member(notes)));
    }
    await this.cloneRelationships(old, member, slideTargets);
    const mainRels = opcRelationshipsPart(this.pkg.main.name); const ridOwners = this.relationshipOwners.get(use.rid)!;
    if (ridOwners.size === 1) {
      this.data.set(mainRels, this.rewriteRelationships(await this.read(mainRels), new Map([[use.rid, this.relative(this.member(this.pkg.main.name), member)]])));
    } else {
      let rid: string; do { rid = `rId_${randomUUID().replaceAll('-', '')}`; } while (this.ids.has(rid)); this.ids.add(rid);
      const xml = `<Relationship xmlns="${PKG}" Id="${rid}" Type="${officeXmlAttribute(use.relationshipType)}" Target="${officeXmlAttribute(this.relative(this.member(this.pkg.main.name), member))}"/>`;
      this.data.set(mainRels, mutateOfficeXml(await this.read(mainRels), () => undefined, this.progress, { namespace: PKG, local: 'Relationships', xml }));
      let order = 0; let found = false;
      this.data.set(this.pkg.main.name, mutateOfficeXml(await this.read(this.pkg.main.name), (tag, parents) => {
        if (parents.length !== 2 || !p(parents[0], 'presentation') || !p(parents[1], 'sldIdLst') || !p(tag, 'sldId') || ++order !== use.order) return;
        const attribute = relationId(tag); if (!attribute || attribute.value !== use.rid) return fail(); found = true;
        return { name: attribute.name, value: rid };
      }, this.progress));
      if (!found) return fail(); ridOwners.delete(slideRef); this.relationshipOwners.set(rid, new Set([slideRef])); use.rid = rid;
    }
    owners.delete(slideRef); this.owners.set(name, new Set([slideRef])); use.part = name;
    await this.registerParts(); this.progress(); return name;
  }
}
