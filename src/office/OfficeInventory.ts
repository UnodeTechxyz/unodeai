import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkbookJsonIndex } from '../content/WorkbookJsonIndex';
import { opcRelationshipsPart } from '../content/OpcReadPackage';
import { xmlAttribute } from '../content/WorkbookXml';
import { OfficePackage, OFFICE_NS, OFFICE_REL, type OfficeKind, type OfficePart, type OfficeRelationship } from './OfficePackage';
import type { SaxesTagNS } from 'saxes';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { OfficeTableInventory } from './OfficeTableInventory';
import { OfficeWordRegions } from './OfficeWordRegions';
import { OfficeWordPictures } from './OfficeWordPictures';
import { prefixWordStoryRecord, type OfficeWordStoryCounts } from './OfficeWordStory';
import { readWordRevisions, wordCommentPartNames, wordCommentRecords, wordParagraphViewFields, wordRevisionRecords, type WordRevisionRead, type WordStoryKind } from './word/WordInventory';

export interface OfficeRecord { kind: string; id: string; record: Record<string, unknown> }
export interface OfficeInventoryManifest { schema_version: 1; sha256: string; kind: OfficeKind; main_part: string; template: boolean; macro_enabled: boolean;
  parts: OfficePart[]; records: number; slides: number; objects: number; paragraphs: number; tables: number; gaps: number; bookmarks?: number; controls?: number; stories?: OfficeWordStoryCounts[];
  revisions?: number; comments?: number; revision_authors?: number;
  thumbnail_parts?: string[] }
export type OfficeRecordWriter = (record: OfficeRecord) => void;
const ns = (tag: SaxesTagNS, key: keyof typeof OFFICE_NS) => OFFICE_NS[key].includes(tag.uri);
export const officeRelationshipId = (tag: SaxesTagNS, local = 'id') => OFFICE_REL.map(uri => xmlAttribute(tag, local, uri)).find(value => value !== undefined);
const attribute = (tag: SaxesTagNS, local: string) => xmlAttribute(tag, local) ?? OFFICE_NS.w.map(uri => xmlAttribute(tag, local, uri)).find(value => value !== undefined);

/** Fixed worker inventory; original bytes and unknown parts are never rewritten or executed. */
export async function indexOfficePackage(source: string, directory: string, snapshot: string, expansionRatio: number, expansionFloor: number, progress: () => void) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(source)) { progress(); hash.update(chunk); }
  const pkg = await OfficePackage.open(source, expansionRatio, expansionFloor, progress); const records = new WorkbookJsonIndex<OfficeRecord>(directory, 'inventory', true);
  const manifest: OfficeInventoryManifest = { schema_version: 1, sha256: hash.digest('hex'), kind: pkg.kind, main_part: pkg.main.ref, template: pkg.template, macro_enabled: pkg.macroEnabled,
    parts: pkg.parts, records: 0, slides: 0, objects: 0, paragraphs: 0, tables: 0, gaps: 0 };
  const emit = (record: OfficeRecord) => { progress(); records.append(record); };
  const gap = (id: string, code: string, part?: string) => { manifest.gaps++; emit({ kind: 'gap', id, record: { code, ...(part ? { part_ref: part } : {}) } }); };
  try {
    manifest.thumbnail_parts = (await pkg.relations('/')).filter(relation => !relation.external && relation.type === 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail' && relation.target)
      .flatMap(relation => [relation.target!, opcRelationshipsPart(relation.target!)])
      .flatMap(name => pkg.part(name) ? [pkg.part(name)!.ref] : []);
    for (const part of pkg.parts) {
      emit({ kind: 'part', id: part.ref, record: { part_ref: part.ref, ...(part.contentType ? { content_type: part.contentType } : {}), main: part.ref === pkg.main.ref } });
      for (const relation of await pkg.relations(part.name)) emit(relationshipRecord(pkg, part, relation));
    }
    const relations = await pkg.relations(pkg.main.name);
    if (pkg.kind === 'pptx') {
      const slides: Array<{ id?: string; relation?: string }> = []; const ancestors: SaxesTagNS[] = [];
      await pkg.zip.xml(pkg.main.name, { open(tag) {
        if (!ancestors.length && (!ns(tag, 'p') || tag.local !== 'presentation')) throw new Error('unsupported-office-package');
        if (ancestors.length === 2 && ns(ancestors[1], 'p') && ancestors[1].local === 'sldIdLst' && ns(tag, 'p') && tag.local === 'sldId') {
          slides.push({ id: attribute(tag, 'id'), relation: officeRelationshipId(tag) });
        }
        ancestors.push(tag);
      }, close() { ancestors.pop(); } });
      manifest.slides = slides.length;
      for (const [index, slide] of slides.entries()) {
        const ref = `S${index + 1}`; const relation = relations.find(relation => relation.id === slide.relation);
        const part = relation?.kind === 'slide' && relation.target ? pkg.part(relation.target) : undefined;
        emit({ kind: 'slide', id: ref, record: { slide_ref: ref, order: index + 1, ...(slide.id ? { slide_id: slide.id } : {}), ...(part ? { part_ref: part.ref } : {}) } });
        if (!part) { gap(`${ref}-part`, 'slide-part-unavailable'); continue; }
        try { const counts = await presentationObjects(pkg, part, snapshot, ref, slide.id, emit, gap); manifest.objects += counts.objects; manifest.tables += counts.tables; }
        catch { gap(`${ref}-xml`, 'slide-xml-unavailable', part.ref); }
      }
    } else {
      const storyParts: Array<{ part: OfficePart; story: WordStoryKind }> = [{ part: pkg.main, story: 'main' }];
      for (const part of pkg.parts) {
        const story = part.contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml' ? 'header'
          : part.contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml' ? 'footer' : undefined;
        if (story) storyParts.push({ part, story });
      }
      // Revisions and comments are read beside the stored inventory; they never make an otherwise readable body fail.
      const word = await readWordRevisions(pkg, storyParts, progress); const authors = new Set<string>(); let revisions = 0;
      const revisionRecords = (part: OfficePart, story: WordStoryKind, paragraphs: number) => {
        const model = word.models.get(part.ref); if (!model) return;
        if (model.paragraphs.length !== paragraphs) { word.models.delete(part.ref); gap(`${story === 'main' ? 'document' : part.ref}-revisions`, 'unsupported-revision-structure', part.ref); return; }
        for (const record of wordRevisionRecords(model, snapshot, part)) { emit(story === 'main' ? record : prefixWordStoryRecord(record, part.ref, story)); revisions++; }
        for (const group of model.groups) if (group.author) authors.add(group.author);
      };
      const counts = await documentObjects(pkg, pkg.main, snapshot, emit, gap, 'main', word); manifest.paragraphs = counts.paragraphs; manifest.tables = counts.tables; manifest.bookmarks = counts.bookmarks; manifest.controls = counts.controls; manifest.objects = counts.pictures;
      revisionRecords(pkg.main, 'main', counts.paragraphs);
      const stories: OfficeWordStoryCounts[] = [];
      for (const { part, story } of storyParts) {
        if (story === 'main') continue;
        try { const storyCounts = await documentObjects(pkg, part, snapshot, emit, gap, story, word); stories.push({ part_ref: part.ref, story, ...storyCounts }); revisionRecords(part, story, storyCounts.paragraphs); }
        catch { word.models.delete(part.ref); gap(`${part.ref}-story-xml`, 'word-story-xml-unavailable', part.ref); }
      }
      if (stories.length) manifest.stories = stories;
      const commentsPart = word.comments ? pkg.part((await wordCommentPartNames(pkg)).comments!)?.ref : undefined;
      const comments = wordCommentRecords(word, snapshot, storyParts, commentsPart);
      for (const record of comments.records) emit(record);
      for (const item of [...word.gaps, ...comments.gaps]) gap(item.id, item.code, item.part);
      manifest.revisions = revisions; manifest.comments = comments.records.length; manifest.revision_authors = authors.size;
    }
    manifest.records = records.count;
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest)); return manifest;
  } finally { records.close(); pkg.close(); }
}

function relationshipRecord(pkg: OfficePackage, owner: OfficePart, relation: OfficeRelationship): OfficeRecord {
  return { kind: 'relationship', id: `${owner.ref}:${relation.id}`, record: { part_ref: owner.ref, relationship_id: relation.id, relationship_kind: relation.kind,
    external: relation.external, ...(relation.target && pkg.part(relation.target) ? { target_part: pkg.part(relation.target)!.ref } : {}),
    ...(relation.invalidTarget ? { target_unavailable: true } : {}) } };
}

interface TextRun { text: string; style: Record<string, string> }
interface Shape { ref: string; kind: string; order: number; id?: string; name?: string; placeholder?: Record<string, string>; parent?: string;
  runs: TextRun[]; paragraphs: number; currentRun?: TextRun; inText: boolean; geometry: Record<string, string>; images: Array<Record<string, string>>; charts: string[] }

type GapWriter = (id: string, code: string, part?: string) => void;
const markupCompatibility = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
async function presentationObjects(pkg: OfficePackage, part: OfficePart, snapshot: string, slideRef: string, slideId: string | undefined, emit: OfficeRecordWriter, gap: GapWriter) {
  const relationships = await pkg.relations(part.name);
  const stack: Shape[] = []; const output: OfficeRecord[] = []; const tableRecords: Parameters<OfficeRecordWriter>[0][] = [];
  const tables = new OfficeTableInventory('pptx', snapshot, part.ref, record => tableRecords.push(record), () => stack.at(-1)?.ref);
  let count = 0; let root = false; let skip = 0; let alternate = 0;
  await pkg.zip.xml(part.name, { open(tag) {
    if (skip) { skip++; return; }
    if (tag.uri === markupCompatibility && tag.local === 'AlternateContent') { skip = 1; gap(`${slideRef}-alternate-${++alternate}`, 'alternate-content-not-selected', part.ref); return; }
    if (!root) { root = true; if (!ns(tag, 'p') || tag.local !== 'sld') throw new Error('invalid-slide'); }
    if (ns(tag, 'p') && ['sp', 'pic', 'graphicFrame', 'cxnSp', 'grpSp'].includes(tag.local)) {
      const parent = stack.at(-1)?.ref; const order = ++count;
      stack.push({ ref: `${slideRef}-O${order}`, kind: tag.local, order, parent, runs: [], paragraphs: 0, inText: false, geometry: {}, images: [], charts: [] });
    }
    tables.open(tag); const shape = stack.at(-1); if (!shape) return;
    if (ns(tag, 'p') && tag.local === 'cNvPr') { shape.id = attribute(tag, 'id'); shape.name = attribute(tag, 'name'); }
    if (ns(tag, 'p') && tag.local === 'ph') shape.placeholder = Object.fromEntries(Object.values(tag.attributes).filter(value => !value.uri).map(value => [value.local, value.value]));
    if (ns(tag, 'a')) {
      if (tag.local === 'p') { if (shape.paragraphs++) shape.runs.push({ text: '\n', style: {} }); }
      if (tag.local === 'r' || tag.local === 'fld') { const run = { text: '', style: {} }; shape.runs.push(run); shape.currentRun = run; }
      if (tag.local === 'rPr' && shape.currentRun) for (const value of Object.values(tag.attributes)) if (!value.uri) shape.currentRun.style[value.local] = value.value;
      if (tag.local === 't') { if (!shape.currentRun) { shape.currentRun = { text: '', style: {} }; shape.runs.push(shape.currentRun); } shape.inText = true; }
      if (tag.local === 'br') { shape.runs.push({ text: '\n', style: {} }); shape.currentRun = undefined; }
      if (tag.local === 'off' || tag.local === 'ext' || tag.local === 'chOff' || tag.local === 'chExt') {
        for (const value of Object.values(tag.attributes)) if (!value.uri && ['x', 'y', 'cx', 'cy'].includes(value.local)) shape.geometry[`${tag.local}_${value.local}`] = value.value;
      }
      if (tag.local === 'blip') {
        const id = officeRelationshipId(tag, 'embed') ?? officeRelationshipId(tag, 'link'); const relation = relationships.find(relation => relation.id === id);
        if (id) shape.images.push({ relationship_id: id, ...(relation?.target && pkg.part(relation.target) ? { part_ref: pkg.part(relation.target)!.ref } : {}) });
      }
    }
    if (['http://schemas.openxmlformats.org/drawingml/2006/chart', 'http://purl.oclc.org/ooxml/drawingml/chart'].includes(tag.uri) && tag.local === 'chart') {
      const id = officeRelationshipId(tag); if (id) shape.charts.push(id);
    }
  }, text(text) { if (skip) return; tables.text(text); const shape = stack.at(-1); if (shape?.inText && shape.currentRun) shape.currentRun.text += text; }, close(tag) {
    if (skip) { skip--; return; }
    tables.close(tag);
    const shape = stack.at(-1);
    if (shape && ns(tag, 'a')) { if (tag.local === 't') shape.inText = false; if (tag.local === 'r' || tag.local === 'fld') shape.currentRun = undefined; }
    if (ns(tag, 'p') && ['sp', 'pic', 'graphicFrame', 'cxnSp', 'grpSp'].includes(tag.local) && shape) {
      stack.pop(); output.push({ kind: 'object', id: shape.ref, record: { object_ref: shape.ref, slide_ref: slideRef, order: shape.order, part_ref: part.ref,
        selector: { snapshot_ref: snapshot, object_ref: shape.ref, ...(slideId ? { slide_id: slideId } : {}) }, object_kind: shape.kind,
        ...(shape.id ? { shape_id: shape.id } : {}), ...(shape.name ? { name: shape.name } : {}), ...(shape.parent ? { parent_object: shape.parent } : {}),
        ...(shape.placeholder ? { placeholder: shape.placeholder } : {}), geometry_emu: shape.geometry, coordinate_space: 'parent',
        text: shape.runs.map(run => run.text).join(''), runs: shape.runs, images: shape.images, chart_relationships: shape.charts,
        style_resolution: 'explicit-run-properties-only', visual_check: 'not-performed' } });
    }
  } });
  for (const record of output.sort((left, right) => (left.record.order as number) - (right.record.order as number))) {
    const charts = record.record.chart_relationships as string[];
    const relation = charts.length === 1 ? relationships.find(item => item.id === charts[0] && item.kind === 'chart' && !item.external && item.target && pkg.part(item.target)) : undefined;
    if (relation?.target) Object.assign(record.record, await chartSummary(pkg, relation.target));
    emit(record);
  }
  for (const record of tableRecords) emit(record);
  return { objects: count, tables: tables.tables };
}

const CHART_NS = ['http://schemas.openxmlformats.org/drawingml/2006/chart', 'http://purl.oclc.org/ooxml/drawingml/chart'];
const DRAWING_NS = ['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main'];
/**
 * The chart's plot type and its stored title. title_source: rich (stored text), reference (cached text of a cell
 * reference), automatic (a title element without text; the application chooses it), deleted, or absent (no stored title).
 */
async function chartSummary(pkg: OfficePackage, part: string): Promise<Record<string, unknown>> {
  const path: SaxesTagNS[] = []; const groups: string[] = []; const paragraphs: string[] = []; const cached: string[] = [];
  let title = false; let rich = false; let reference = false; let deleted = false; let sink: string[] | undefined;
  /** The open path starts with these chart-namespace elements (and is exactly that long when `exact`). */
  const under = (locals: string[], exact = false) => (exact ? path.length === locals.length : path.length >= locals.length)
    && locals.every((local, index) => CHART_NS.includes(path[index].uri) && path[index].local === local);
  try {
    await pkg.zip.xml(part, { open(tag) {
      path.push(tag); const chart = CHART_NS.includes(tag.uri); const drawing = DRAWING_NS.includes(tag.uri);
      if (chart && tag.local.endsWith('Chart') && under(['chartSpace', 'chart', 'plotArea', tag.local], true)) groups.push(tag.local);
      if (chart && under(['chartSpace', 'chart', 'autoTitleDeleted'], true)) deleted = ['1', 'true'].includes(xmlAttribute(tag, 'val') ?? 'true');
      if (chart && under(['chartSpace', 'chart', 'title'], true)) title = true;
      if (chart && under(['chartSpace', 'chart', 'title', 'tx', 'rich'], true)) rich = true;
      if (chart && under(['chartSpace', 'chart', 'title', 'tx', 'strRef'], true)) reference = true;
      if (drawing && tag.local === 'p' && path.length === 6 && under(['chartSpace', 'chart', 'title', 'tx', 'rich'])) paragraphs.push('');
      if (drawing && tag.local === 't' && paragraphs.length && under(['chartSpace', 'chart', 'title', 'tx', 'rich'])) sink = paragraphs;
      if (chart && tag.local === 'v' && under(['chartSpace', 'chart', 'title', 'tx', 'strRef', 'strCache'])) { cached.push(''); sink = cached; }
    }, text(text) { if (sink) sink[sink.length - 1] += text; },
    close() { path.pop(); sink = undefined; } });
  } catch { return { chart_kind: 'unavailable' }; }
  const chart_kind = groups.length === 1 ? groups[0] : groups.length ? 'combo' : 'unknown';
  if (rich) return { chart_kind, title: paragraphs.join('\n'), title_source: 'rich' };
  if (reference) return { chart_kind, title: cached.join(''), title_source: 'reference' };
  return { chart_kind, title: null, title_source: title ? 'automatic' : deleted ? 'deleted' : 'absent' };
}

async function documentObjects(pkg: OfficePackage, part: OfficePart, snapshot: string, write: OfficeRecordWriter, gap: GapWriter, story: 'main' | 'header' | 'footer' = 'main', word?: WordRevisionRead) {
  let model = word?.models.get(part.ref);
  const emit: OfficeRecordWriter = story === 'main' ? write : record => write(prefixWordStoryRecord(record, part.ref, story));
  let paragraphs = 0; let root = false; let body = false; let skip = 0; let alternate = 0;
  const tables = new OfficeTableInventory('docx', snapshot, part.ref, emit);
  const regions = new OfficeWordRegions(snapshot, part.ref, emit);
  const pictures = new OfficeWordPictures(snapshot, part.ref, emit, await pkg.relations(part.name), name => pkg.part(name)?.ref);
  const stack: Array<{ ref: string; runs: TextRun[]; current?: TextRun; inText: boolean; cell?: string }> = [];
  await pkg.zip.xml(part.name, { open(tag) {
    if (skip) { skip++; return; }
    if (tag.uri === markupCompatibility && tag.local === 'AlternateContent') { skip = 1; gap(`${story === 'main' ? 'document' : part.ref}-alternate-${++alternate}`, 'alternate-content-not-selected', part.ref); return; }
    if (!root) { root = true; if (!ns(tag, 'w') || tag.local !== (story === 'main' ? 'document' : story === 'header' ? 'hdr' : 'ftr')) throw new Error('unsupported-office-package'); if (story !== 'main') body = true; }
    if (ns(tag, 'w') && tag.local === 'body') body = true; if (!body) return;
    tables.open(tag); regions.open(tag); pictures.open(tag); if (!ns(tag, 'w')) return;
    if (tag.local === 'p') { const ref = `D${++paragraphs}`; stack.push({ ref, runs: [], inText: false, cell: tables.cellRef }); tables.paragraph(ref); }
    const paragraph = stack.at(-1); if (!paragraph) return;
    if (tag.local === 'r') { paragraph.current = { text: '', style: {} }; paragraph.runs.push(paragraph.current); }
    if (tag.local === 't') paragraph.inText = true;
    if (tag.local === 'tab' && paragraph.current) paragraph.current.text += '\t';
    if ((tag.local === 'br' || tag.local === 'cr') && paragraph.current) paragraph.current.text += '\n';
    if (paragraph.current && ['b', 'i', 'sz', 'lang', 'rStyle', 'vanish'].includes(tag.local)) paragraph.current.style[tag.local] = attribute(tag, 'val') ?? 'true';
  }, text(text) { if (skip) return; tables.text(text); if (body) regions.text(text); const paragraph = stack.at(-1); if (paragraph?.inText && paragraph.current) paragraph.current.text += text; }, close(tag) {
    if (skip) { skip--; return; }
    if (body) { tables.close(tag); regions.close(tag); pictures.close(tag); }
    if (!ns(tag, 'w')) return; const paragraph = stack.at(-1);
    if (paragraph) { if (tag.local === 't') paragraph.inText = false; if (tag.local === 'r') paragraph.current = undefined; }
    if (tag.local === 'p' && paragraph) {
      stack.pop(); const stored = paragraph.runs.map(run => run.text).join(''); const ordinal = Number(paragraph.ref.slice(1));
      // Revision views apply only where the revision model reads the same stored paragraph as this inventory.
      const aligned = model?.paragraphs[ordinal - 1]?.stored === stored;
      if (model && !aligned) { word!.models.delete(part.ref); model = undefined; gap(`${story === 'main' ? 'document' : part.ref}-revisions`, 'unsupported-revision-structure', part.ref); }
      const views = aligned ? wordParagraphViewFields(model, ordinal, word!.commentRefs) : undefined;
      emit({ kind: 'paragraph', id: paragraph.ref, record: { paragraph_ref: paragraph.ref, part_ref: part.ref,
        selector: { snapshot_ref: snapshot, paragraph_ref: paragraph.ref }, ...(paragraph.cell ? { cell_ref: paragraph.cell } : {}), text: views ? views.text : stored, runs: paragraph.runs,
        ...(views ? { views: views.views } : {}), style_resolution: 'explicit-run-properties-only', field_refresh: 'not-performed' } });
    }
    if (tag.local === 'body') body = false;
  } }); regions.finish(); return { paragraphs, tables: tables.tables, bookmarks: regions.bookmarks, controls: regions.controls, pictures: pictures.pictures };
}
