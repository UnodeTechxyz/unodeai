import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { posix } from 'node:path';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { OfficePackage, type OfficeKind } from './OfficePackage';
import { officeXmlElements } from './OfficeXmlElements';
import { filterOfficeRenderXml } from './OfficeRenderXml';
import { decodeOfficeXml, encodeOfficeXml } from './OfficeTextPatch';
import { officeXmlAttribute } from './OfficeXmlMutations';
import { hostReadMemoryBudget, CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO, CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES } from '../content/ContentAssetStore';
import { decodePng, ImageDecodeFailure } from './PngDecode';
import { decodeJpeg } from './JpegDecode';

const PREFIX = 'application/vnd.openxmlformats-officedocument.';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const types = (suffixes: string[]) => suffixes.map(suffix => PREFIX + suffix + '+xml');
const wordMain = PREFIX + 'wordprocessingml.document.main+xml';
const pptMain = PREFIX + 'presentationml.presentation.main+xml';
/** Closed relationship -> destination content-type policy; executable/embedded packages and arbitrary XML never enter the copy. */
const destinations: Record<string, string[]> = {
  styles: types(['wordprocessingml.styles']), stylesWithEffects: types(['wordprocessingml.stylesWithEffects']),
  settings: types(['wordprocessingml.settings']), webSettings: types(['wordprocessingml.webSettings']),
  fontTable: types(['wordprocessingml.fontTable']), numbering: types(['wordprocessingml.numbering']),
  header: types(['wordprocessingml.header']), footer: types(['wordprocessingml.footer']),
  footnotes: types(['wordprocessingml.footnotes']), endnotes: types(['wordprocessingml.endnotes']),
  slide: types(['presentationml.slide']), slideLayout: types(['presentationml.slideLayout']), slideMaster: types(['presentationml.slideMaster']),
  notesSlide: types(['presentationml.notesSlide']), notesMaster: types(['presentationml.notesMaster']), handoutMaster: types(['presentationml.handoutMaster']),
  presProps: types(['presentationml.presProps']), viewProps: types(['presentationml.viewProps']), tableStyles: types(['presentationml.tableStyles']),
  theme: types(['theme']), chart: types(['drawingml.chart']), image: ['image/png', 'image/jpeg'],
  // v0.9.108: Word comments and their thread metadata; the metadata parts keep only the named thread elements.
  comments: types(['wordprocessingml.comments']), commentsExtended: types(['wordprocessingml.commentsExtended']), commentsIds: types(['wordprocessingml.commentsIds']),
  commentsExtensible: types(['wordprocessingml.commentsExtensible']), people: types(['wordprocessingml.people']),
};
const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml';
const commentMetadata: Record<string, Set<string>> = {
  [PREFIX + 'wordprocessingml.commentsExtended+xml']: new Set([`${W15}|commentsEx`, `${W15}|commentEx`]),
  [PREFIX + 'wordprocessingml.commentsIds+xml']: new Set(['http://schemas.microsoft.com/office/word/2016/wordml/cid|commentsIds', 'http://schemas.microsoft.com/office/word/2016/wordml/cid|commentId']),
  [PREFIX + 'wordprocessingml.commentsExtensible+xml']: new Set(['http://schemas.microsoft.com/office/word/2018/wordml/cex|commentsExtensible', 'http://schemas.microsoft.com/office/word/2018/wordml/cex|commentExtensible']),
  [PREFIX + 'wordprocessingml.people+xml']: new Set([`${W15}|people`, `${W15}|person`, `${W15}|presenceInfo`]),
};
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function removeProcessingInstructions(bytes: Buffer): { bytes: Buffer; count: number } {
  const decoded = decodeOfficeXml(bytes); const parser = new SaxesParser({ xmlns: true }); const cuts: Array<{ start: number; end: number }> = [];
  parser.on('processinginstruction', () => { cuts.push({ start: decoded.xml.lastIndexOf('<?', parser.position - 1), end: parser.position }); });
  parser.write(decoded.xml).close(); let text = decoded.xml;
  for (const cut of cuts.reverse()) text = text.slice(0, cut.start) + text.slice(cut.end);
  return { bytes: encodeOfficeXml({ ...decoded, xml: text }), count: cuts.length };
}
async function boundedSnapshot(source: string, budget: number): Promise<Buffer> {
  if (!Number.isSafeInteger(budget) || budget <= 0) throw Error('render-copy-memory-limited');
  const handle = await open(source, 'r');
  try {
    const before = await handle.stat(); if (!before.isFile() || before.size > budget) throw Error('render-copy-memory-limited');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { size += chunk.length; if (size > budget) throw Error('render-copy-memory-limited'); chunks.push(Buffer.from(chunk)); }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || size !== before.size) throw Error('render-copy-source-changed');
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}
export interface OfficeRenderCopyFact {
  kind: OfficeKind; source_sha256: string; render_copy_sha256: string; macro_source: boolean;
  removed_parts: number; removed_relationships: number; removed_elements: number; partial: boolean;
  removed_metadata_parts: number; compatibility_resolutions: number; compatibility_fallbacks: number;
  neutralized_chart_formulas: number;
  native_charts?: number;
  /** v0.9.108: package part names left out of the copy (at most 50; internal part names, never external targets). */
  removed_part_names?: string[];
  scope: string;
}
export interface OfficeRenderCopy { bytes: Buffer; fact: OfficeRenderCopyFact }

/** Only for the host's private immutable input snapshot. Does not edit or open the user's original in an application. */
export async function makeOfficeRenderCopy(source: string, progress: () => void, memoryBudget = hostReadMemoryBudget()): Promise<OfficeRenderCopy> {
  const sourceHash = hash(await boundedSnapshot(source, memoryBudget));
  const pkg = await OfficePackage.open(source, CONTENT_ASSET_ZIP_MAX_EXPANSION_RATIO, CONTENT_ASSET_ZIP_EXPANSION_FLOOR_BYTES, progress);
  try {
    const kept = new Map<string, { member: string; type: string; bytes: Buffer }>();
    const unavailableImages = new Set<string>();
    const edges = new Map<string, Array<{ id: string; type: string; target: string }>>();
    const admittedIds = new Map<string, Set<string>>(); let consumed = 0; let removedRelationships = 0; let removedElements = 0;
    let compatibilityResolutions = 0; let compatibilityFallbacks = 0; let neutralizedChartFormulas = 0;
    const admit = async (name: string, type: string) => {
      if (kept.has(name)) return true;
      if (unavailableImages.has(name)) return false;
      const chunks: Buffer[] = [];
      for await (const bytes of pkg.zip.bytes(name)) { consumed += bytes.length; if (consumed > memoryBudget) throw Error('render-copy-memory-limited'); chunks.push(Buffer.from(bytes)); }
      const bytes = Buffer.concat(chunks);
      try {
        if (type === 'image/png') decodePng(bytes, memoryBudget);
        else if (type === 'image/jpeg') await decodeJpeg(bytes, memoryBudget);
        else officeXmlElements(bytes, progress); // DTD/encoding/malformed XML is never passed to a native application.
      } catch (error) { if (error instanceof ImageDecodeFailure) { unavailableImages.add(name); consumed -= bytes.length; return false; } throw error; }
      kept.set(name, { member: pkg.zip.memberName(name), type, bytes });
      return true;
    };
    await admit(pkg.main.name, pkg.kind === 'docx' ? wordMain : pptMain);
    const queue = [pkg.main.name];
    for (let at = 0; at < queue.length; at++) {
      progress(); const owner = queue[at]; const outgoing: Array<{ id: string; type: string; target: string }> = []; const ids = new Set<string>();
      for (const relation of await pkg.relations(owner)) {
        const target = relation.target ? pkg.part(relation.target) : undefined; const allowed = destinations[relation.kind];
        if (relation.external || !target?.contentType || !Array.isArray(allowed) || !allowed.includes(target.contentType) || !relation.target) { removedRelationships++; continue; }
        if (!kept.has(target.name)) { if (!await admit(target.name, target.contentType)) { removedRelationships++; continue; } queue.push(target.name); }
        outgoing.push({ id: relation.id, type: relation.type, target: target.name }); ids.add(relation.id);
      }
      edges.set(owner, outgoing); admittedIds.set(owner, ids);
    }
    const zip = new JSZip();
    for (const [name, part] of kept) {
      let bytes = part.bytes;
      if (part.type.endsWith('+xml')) {
        const instructions = removeProcessingInstructions(bytes); bytes = instructions.bytes; removedElements += instructions.count;
        const filtered = filterOfficeRenderXml(bytes, admittedIds.get(name) ?? new Set<string>(), progress, commentMetadata[part.type]);
        bytes = filtered.bytes; removedElements += filtered.removedElements;
        compatibilityResolutions += filtered.compatibilityResolutions; compatibilityFallbacks += filtered.compatibilityFallbacks;
        neutralizedChartFormulas += filtered.neutralizedChartFormulas;
      }
      zip.file(part.member, bytes, { createFolders: false });
      const outgoing = edges.get(name)!;
      if (outgoing.length) {
        const member = posix.join(posix.dirname(part.member), '_rels', posix.basename(part.member) + '.rels');
        zip.file(member, `<Relationships xmlns="${RELS}">${outgoing.map(relation => `<Relationship Id="${officeXmlAttribute(relation.id)}" Type="${officeXmlAttribute(relation.type)}" Target="${officeXmlAttribute(posix.relative(posix.dirname(part.member), kept.get(relation.target)!.member))}"/>`).join('')}</Relationships>`, { createFolders: false });
      }
    }
    const mainRelation = (await pkg.relations('/')).find(relation => relation.kind === 'officeDocument')!;
    zip.file('_rels/.rels', `<Relationships xmlns="${RELS}"><Relationship Id="main" Type="${officeXmlAttribute(mainRelation.type)}" Target="${officeXmlAttribute(kept.get(pkg.main.name)!.member)}"/></Relationships>`, { createFolders: false });
    zip.file('[Content_Types].xml', `<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>${[...kept.values()].map(part => `<Override PartName="/${officeXmlAttribute(part.member)}" ContentType="${officeXmlAttribute(part.type)}"/>`).join('')}</Types>`, { createFolders: false });
    progress(); const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }, progress);
    if (bytes.length > memoryBudget) throw Error('render-copy-memory-limited');
    if (hash(await boundedSnapshot(source, memoryBudget)) !== sourceHash) throw Error('render-copy-source-changed');
    const omitted = pkg.parts.filter(part => !kept.has(part.name) && !/\/_RELS\/[^/]*\.RELS$/i.test(part.name));
    const removedParts = omitted.length;
    const metadataTypes = new Set(['application/vnd.openxmlformats-package.core-properties+xml', ...types(['extended-properties', 'custom-properties'])]);
    const removedMetadata = omitted.filter(part => metadataTypes.has(part.contentType ?? '')).length;
    return { bytes, fact: { kind: pkg.kind, source_sha256: sourceHash, render_copy_sha256: hash(bytes), macro_source: pkg.macroEnabled,
      removed_parts: removedParts, removed_relationships: removedRelationships, removed_elements: removedElements,
      removed_metadata_parts: removedMetadata, compatibility_resolutions: compatibilityResolutions, compatibility_fallbacks: compatibilityFallbacks,
      neutralized_chart_formulas: neutralizedChartFormulas,
      removed_part_names: omitted.slice(0, 50).map(part => part.name),
      native_charts: [...kept.values()].filter(part => part.type === PREFIX + 'drawingml.chart+xml').length,
      partial: pkg.macroEnabled || removedParts > removedMetadata || removedRelationships > 0 || removedElements > 0 || compatibilityFallbacks > 0 || neutralizedChartFormulas > 0,
      scope: 'Passive render copy only. Removed content is not rendered; charts use caches and only passive local range references, layout-only counters may refresh. No Office fidelity, OS network isolation or original-file modification claim.' } };
  } finally { pkg.close(); }
}
