import { posix } from 'node:path';
import { ReadOnlyOpc, opcPartName, opcRelationshipTarget, opcRelationshipsPart } from '../content/OpcReadPackage';
import { xmlAttribute } from '../content/WorkbookXml';

export type OfficeKind = 'docx' | 'pptx';
export interface OfficeRelationship { id: string; type: string; kind: string; external: boolean; target?: string; invalidTarget?: boolean }
export interface OfficePart { ref: string; name: string; contentType?: string }
export const OFFICE_REL = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'];
export const OFFICE_NS = {
  p: ['http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main'],
  a: ['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main'],
  w: ['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'],
};
/** Microsoft Word comment metadata relationships (2011/2016/2018 namespaces); every other non-OOXML type stays unknown. */
const MICROSOFT_RELATIONSHIP_KINDS: Record<string, string> = {
  'http://schemas.microsoft.com/office/2011/relationships/commentsExtended': 'commentsExtended',
  'http://schemas.microsoft.com/office/2016/09/relationships/commentsIds': 'commentsIds',
  'http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible': 'commentsExtensible',
  'http://schemas.microsoft.com/office/2011/relationships/people': 'people',
};
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const fail = (): never => { throw new Error('unsupported-office-package'); };

/** Passive OPC graph. No application, resolver, external URL or executable content is invoked. */
export class OfficePackage {
  readonly parts: OfficePart[];
  readonly main: OfficePart;
  readonly kind: OfficeKind;
  readonly template: boolean;
  readonly macroEnabled: boolean;
  private readonly relationCache = new Map<string, OfficeRelationship[]>();
  private constructor(readonly zip: ReadOnlyOpc, parts: OfficePart[], main: OfficePart, kind: OfficeKind, template: boolean, macroEnabled: boolean) {
    this.parts = parts; this.main = main; this.kind = kind; this.template = template; this.macroEnabled = macroEnabled;
  }

  static async open(source: string, expansionRatio: number, expansionFloor: number, progress: () => void): Promise<OfficePackage> {
    const zip = await ReadOnlyOpc.open(source, expansionRatio, expansionFloor, progress);
    try {
      const defaults = new Map<string, string>(); const overrides = new Map<string, string>();
      let depth = 0;
      await zip.xml('/[Content_Types].xml', { open(tag) {
        depth++; if (depth === 1 && (tag.uri !== CT || tag.local !== 'Types')) return fail();
        if (depth !== 2 || tag.uri !== CT) return;
        const content = xmlAttribute(tag, 'ContentType'); if (!content) return;
        if (tag.local === 'Override') {
          const name = xmlAttribute(tag, 'PartName'); if (!name) return fail(); const key = opcPartName(name);
          if (overrides.has(key)) return fail(); overrides.set(key, content);
        } else if (tag.local === 'Default') {
          const extension = xmlAttribute(tag, 'Extension')?.toLowerCase(); if (!extension || defaults.has(extension)) return fail(); defaults.set(extension, content);
        }
      }, close() { depth--; } });
      const parts = zip.names().sort().filter(name => name !== '/[CONTENT_TYPES].XML').map((name, index) => ({ ref: `P${index + 1}`, name,
        contentType: overrides.get(name) ?? defaults.get(posix.extname(name).slice(1).toLowerCase()) }));
      const roots = await OfficePackage.relationships(zip, '/'); const mains = roots.filter(relation => relation.kind === 'officeDocument');
      if (mains.length !== 1 || mains[0].external || !mains[0].target) return fail();
      const main = parts.find(part => part.name === mains[0].target); if (!main?.contentType) return fail();
      const type = main.contentType.toLowerCase();
      const kind = /^(?:application\/vnd\.openxmlformats-officedocument\.presentationml\.(?:presentation|template|slideshow)|application\/vnd\.ms-powerpoint\.(?:presentation|template|slideshow)\.macroenabled)\.main\+xml$/.test(type) ? 'pptx'
        : /^(?:application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.(?:document|template)|application\/vnd\.ms-word\.(?:document\.macroenabled|template\.macroenabledtemplate))\.main\+xml$/.test(type) ? 'docx' : undefined;
      if (!kind) return fail();
      const result = new OfficePackage(zip, parts, main, kind, type.includes('template'), type.includes('macroenabled'));
      result.relationCache.set('/', roots); return result;
    } catch (error) { zip.close(); throw error; }
  }

  private static async relationships(zip: ReadOnlyOpc, owner: string): Promise<OfficeRelationship[]> {
    const name = opcRelationshipsPart(owner); if (!zip.has(name)) return [];
    const relations: OfficeRelationship[] = []; const ids = new Set<string>();
    let depth = 0;
    await zip.xml(name, { open(tag) {
      depth++; if (depth === 1 && (tag.uri !== PKG || tag.local !== 'Relationships')) return fail();
      if (depth !== 2 || tag.uri !== PKG || tag.local !== 'Relationship') return;
      const id = xmlAttribute(tag, 'Id'); const type = xmlAttribute(tag, 'Type'); const target = xmlAttribute(tag, 'Target');
      if (!id || !type || !target || ids.has(id)) return fail(); ids.add(id);
      const base = OFFICE_REL.find(base => type.startsWith(base + '/'));
      const relation: OfficeRelationship = { id, type, kind: base ? type.slice(base.length + 1) : MICROSOFT_RELATIONSHIP_KINDS[type] ?? 'unknown', external: xmlAttribute(tag, 'TargetMode') === 'External' };
      if (!relation.external) {
        try { relation.target = opcRelationshipTarget(owner, target); }
        catch { relation.invalidTarget = true; }
      }
      // External targets can carry credentials. Inventory needs presence/type/id, never the URL itself.
      relations.push(relation);
    }, close() { depth--; } }); return relations;
  }

  async relations(owner: string): Promise<OfficeRelationship[]> {
    let relations = this.relationCache.get(owner); if (!relations) { relations = await OfficePackage.relationships(this.zip, owner); this.relationCache.set(owner, relations); }
    return relations;
  }
  part(name: string): OfficePart | undefined { return this.parts.find(part => part.name === opcPartName(name)); }
  partByRef(ref: string): OfficePart | undefined { return this.parts.find(part => part.ref === ref); }
  close(): void { this.zip.close(); }
}
