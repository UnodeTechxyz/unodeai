// Tracked Word edits (w:ins / w:del with author and date) and accept/reject of inspected revisions. Pure JavaScript.
import { officeXmlElements, type OfficeXmlDocument, type OfficeXmlElement } from '../OfficeXmlElements';
import { encodeOfficeXml } from '../OfficeTextPatch';
import { officeXmlAttribute, officeXmlOpening } from '../OfficeXmlMutations';
import { OfficeEditFailure, type OfficeEditCode } from '../OfficeEditContracts';
import { officeWordRegionSpan } from '../OfficeWordRegionSpan';
import { isWordElement as w, wordAttribute, wordDescendants, wordElementText } from './WordXml';
import type { WordIdAllocator } from './WordIdAllocator';
import { wordStoryModelFromXml, type WordRevisionGroup } from './WordRevisionModel';

export interface WordTrackingSession { author: string; initials: string; date: string; ids: WordIdAllocator }
export type WordTrackedTarget = { kind: 'paragraph'; ordinal: number } | { kind: 'cell'; ref: string } | { kind: 'region'; ref: string };
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const containers = new Set(['ins', 'del', 'moveFrom', 'moveTo']);
const wrappers = new Set(['sdt', 'sdtContent', 'customXml']);
const fail = (code: OfficeEditCode): never => { throw new OfficeEditFailure(code); };
export const escapeWordText = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\r', '&#13;');

export function withinWordBody(element: OfficeXmlElement) {
  let body = false;
  for (let at: OfficeXmlElement | undefined = element; at; at = at.parent) { if (at.tag.uri === MC && at.tag.local === 'AlternateContent') return false; if (w(at, 'body')) body = true; }
  return body;
}
export const wordBodyParagraphs = (parsed: OfficeXmlDocument) => parsed.elements.filter(element => w(element, 'p') && withinWordBody(element));
const ancestorsTo = (element: OfficeXmlElement, stop: OfficeXmlElement) => { const found: OfficeXmlElement[] = []; for (let at = element.parent; at && at !== stop; at = at.parent) found.push(at); return found; };
const own = (element: OfficeXmlElement, session: WordTrackingSession) => session.ids.own.has(wordAttribute(element, 'id') ?? '');

/** Names for a new WordprocessingML element beside an existing one: its prefix when it has one, else a local declaration. */
export function wordNames(near: OfficeXmlElement) {
  const prefix = near.tag.prefix; const uri = near.tag.uri;
  // A prefix declared only on that element itself is not in scope beside it, so the new element declares it again.
  const selfDeclared = Object.values(near.tag.attributes).some(attribute => attribute.name === `xmlns:${prefix}`);
  return prefix ? { element: (local: string) => `${prefix}:${local}`, attribute: (local: string) => `${prefix}:${local}`, declare: selfDeclared ? ` xmlns:${prefix}="${officeXmlAttribute(uri)}"` : '' }
    : { element: (local: string) => local, attribute: (local: string) => `uw:${local}`, declare: ` xmlns:uw="${officeXmlAttribute(uri)}"` };
}
export function wordRevisionOpening(local: 'ins' | 'del', near: OfficeXmlElement, session: WordTrackingSession, selfClosing = false) {
  const name = wordNames(near);
  return `<${name.element(local)}${name.declare} ${name.attribute('id')}="${session.ids.allocate()}" ${name.attribute('author')}="${officeXmlAttribute(session.author)}" ${name.attribute('date')}="${session.date}"${selfClosing ? '/>' : '>'}`;
}
export function wordRunContent(text: string, near: OfficeXmlElement) {
  const name = wordNames(near); const declare = name.declare;
  return text.split(/([\n\t])/).filter(part => part !== '').map(part => part === '\n' ? `<${name.element('br')}${declare}/>` : part === '\t' ? `<${name.element('tab')}${declare}/>`
    : `<${name.element('t')}${declare} xml:space="preserve">${escapeWordText(part)}</${name.element('t')}>`).join('');
}

const everything = () => true;
export interface WordPiece { text: string; node?: OfficeXmlElement; run?: OfficeXmlElement; paragraph?: OfficeXmlElement; boundary?: boolean; paragraphBreak?: boolean }
/** The current (accepted) text of the scope, with untouchable boundaries where the untracked editor has them. */
export function wordCurrentPieces(paragraphs: OfficeXmlElement[], xml: string, inside: (element: OfficeXmlElement) => boolean = everything, overlaps: (element: OfficeXmlElement) => boolean = everything): WordPiece[] {
  const pieces: WordPiece[] = []; const region = overlaps !== everything;
  const visit = (element: OfficeXmlElement, paragraph: OfficeXmlElement) => {
    for (const child of element.children) {
      if (!inside(child) && !overlaps(child)) continue;
      if (w(child, 'p')) continue;
      if (child.tag.uri === MC && child.tag.local === 'AlternateContent') { pieces.push({ text: '', boundary: true }); continue; }
      if (w(child, 'del') || w(child, 'moveFrom')) continue;
      // Fields, equations and (in a region) controls nested inside the span are boundaries a match cannot cross, as in the
      // untracked editor. The selected control's own wrapper starts before the span and is not one.
      const field = w(child, 'fldSimple') || child.tag.local === 'oMath' || region && w(child, 'sdt') && inside(child);
      if (field) pieces.push({ text: '', boundary: true });
      if (w(element, 'r')) {
        if (w(child, 't')) { if (inside(child)) pieces.push({ text: wordElementText(xml, child), node: child, run: element, paragraph }); continue; }
        if (w(child, 'tab') || w(child, 'br') || w(child, 'cr')) { if (inside(child)) pieces.push({ text: w(child, 'tab') ? '\t' : '\n', node: child, run: element, paragraph }); continue; }
        if (w(child, 'rPr') || w(child, 'lastRenderedPageBreak')) continue;
        pieces.push({ text: '', boundary: true }); continue;
      }
      visit(child, paragraph);
      if (field) pieces.push({ text: '', boundary: true });
    }
  };
  paragraphs.forEach((paragraph, index) => { if (index) pieces.push({ text: '\n', boundary: true, paragraphBreak: true }); visit(paragraph, paragraph); });
  return pieces;
}
const structuralParent = (element: OfficeXmlElement) => { let at = element.parent; while (at && w(at) && wrappers.has(at.tag.local)) at = at.parent; return at; };
function scope(parsed: OfficeXmlDocument, target: WordTrackedTarget, progress: () => void) {
  const paragraphs = wordBodyParagraphs(parsed);
  if (target.kind === 'paragraph') { const paragraph = paragraphs[target.ordinal - 1]; if (!paragraph) return fail('unsupported-edit-target'); return { paragraphs: [paragraph], inside: undefined, overlaps: undefined }; }
  if (target.kind === 'cell') {
    const match = /^T([1-9]\d*)-R([1-9]\d*)-C([1-9]\d*)$/.exec(target.ref); if (!match) return fail('unsupported-edit-target');
    const table = parsed.elements.filter(element => w(element, 'tbl') && withinWordBody(element))[Number(match[1]) - 1];
    const row = table ? parsed.elements.filter(element => w(element, 'tr') && structuralParent(element) === table)[Number(match[2]) - 1] : undefined;
    const cell = row ? parsed.elements.filter(element => w(element, 'tc') && structuralParent(element) === row)[Number(match[3]) - 1] : undefined;
    if (!cell) return fail('unsupported-edit-target');
    const innermostCell = (element: OfficeXmlElement) => { for (let at = element.parent; at; at = at.parent) if (w(at, 'tc')) return at; return undefined; };
    return { paragraphs: paragraphs.filter(paragraph => innermostCell(paragraph) === cell), inside: undefined, overlaps: undefined };
  }
  const span = officeWordRegionSpan(parsed.decoded.xml, target.ref, progress);
  const inside = (element: OfficeXmlElement) => element.start >= span.start && element.openEnd <= span.end;
  // Text inside the span counts; an element that only partly overlaps it is walked for the text it holds inside the span.
  const overlaps = (element: OfficeXmlElement) => element.end > span.start && element.start < span.end;
  return { paragraphs: paragraphs.filter(overlaps), inside, overlaps };
}
export function wordCurrentTargetText(bytes: Buffer, target: WordTrackedTarget, progress: () => void) {
  const parsed = officeXmlElements(bytes, progress); const selected = scope(parsed, target, progress);
  return wordCurrentPieces(selected.paragraphs, parsed.decoded.xml, selected.inside, selected.overlaps).map(piece => piece.text).join('');
}

interface Range { start: number; end: number; match: number }
/**
 * Tracked replace inside one inspected target: matched text is wrapped in w:del (w:t becomes w:delText) and the replacement is
 * a new w:ins run copying the first replaced run's properties without its property history. Runs are split only at text
 * offsets; both halves keep the original run properties (a copied rPrChange gets a new ID). Text this request inserted is
 * edited in place. Another person's or an earlier request's revision inside or around the match is refused.
 */
export function trackedReplaceText(bytes: Buffer, target: WordTrackedTarget, find: string, replacement: string, all: boolean, session: WordTrackingSession, progress: () => void) {
  if (!find) return fail('empty-text-match');
  const parsed = officeXmlElements(bytes, progress); const xml = parsed.decoded.xml; const selected = scope(parsed, target, progress);
  const pieces = wordCurrentPieces(selected.paragraphs, xml, selected.inside, selected.overlaps); let at = 0;
  const placed = pieces.map(piece => { const start = at; at += piece.text.length; return { ...piece, start, end: at }; });
  const text = pieces.map(piece => piece.text).join(''); const starts: number[] = [];
  for (let offset = 0; ; ) { progress(); const found = text.indexOf(find, offset); if (found < 0) break; starts.push(found); if (!all) break; offset = found + find.length; }
  if (!starts.length) return fail('text-not-found');
  const normalized = replacement.replace(/\r\n?/g, '\n');
  if (find === normalized) return { bytes: Buffer.from(bytes), replacements: starts.length, revisions: 0 };
  const ranges: Range[] = starts.map((start, match) => ({ start, end: start + find.length, match }));
  const covered = new Map<OfficeXmlElement, Array<{ from: number; to: number; match: number }>>(); const lastRun = new Map<number, OfficeXmlElement>(); const firstRun = new Map<number, OfficeXmlElement>();
  for (const range of ranges) {
    const touched = placed.filter(piece => piece.start < range.end && piece.end > range.start || piece.boundary && piece.start > range.start && piece.start < range.end);
    // A tracked change is recorded inside one paragraph; a match across paragraphs needs an untracked edit or separate matches.
    if (touched.some(piece => piece.paragraphBreak)) return fail('edit-not-trackable');
    if (touched.some(piece => piece.boundary || !piece.node)) return fail('text-match-crosses-structural-control');
    const paragraph = touched[0].paragraph!;
    for (const piece of touched) {
      if (ancestorsTo(piece.node!, paragraph).some(element => w(element) && containers.has(element.tag.local) && !own(element, session))) return fail('overlaps-foreign-revision');
    }
    const first = touched[0].node!; const last = touched.at(-1)!.node!;
    for (const element of wordDescendants(paragraph)) {
      if (element.start > first.start && element.start < last.end && w(element) && containers.has(element.tag.local) && !own(element, session)) return fail('overlaps-foreign-revision');
    }
    for (const piece of touched) {
      const list = covered.get(piece.node!) ?? []; covered.set(piece.node!, list);
      list.push({ from: Math.max(0, range.start - piece.start), to: Math.min(piece.text.length, range.end - piece.start), match: range.match });
    }
    firstRun.set(range.match, touched[0].run!); lastRun.set(range.match, touched.at(-1)!.run!);
  }
  const runs = [...new Set(placed.filter(piece => piece.node && covered.has(piece.node)).map(piece => piece.run!))].sort((left, right) => left.start - right.start);
  let revisions = 0;
  const newRun = (match: number) => {
    const run = firstRun.get(match)!; const properties = run.children.find(child => w(child, 'rPr'));
    let rPr = properties ? xml.slice(properties.start, properties.end) : '';
    const change = properties?.children.find(child => w(child, 'rPrChange'));
    if (properties && change) rPr = xml.slice(properties.start, change.start) + xml.slice(change.end, properties.end);
    return `<${run.tag.name}${wordNames(run).declare}>${rPr}${wordRunContent(normalized, run)}</${run.tag.name}>`;
  };
  const patches: Patch[] = [];
  for (const run of runs) {
    const properties = run.children.find(child => w(child, 'rPr')); const change = properties?.children.find(child => w(child, 'rPrChange'));
    let copies = 0;
    const rPr = () => {
      if (!properties) return ''; if (copies++ === 0 || !change) return xml.slice(properties.start, properties.end);
      const opening = officeXmlOpening(xml.slice(change.start, change.openEnd), change.tag.prefix ? `${change.tag.prefix}:id` : 'id', session.ids.allocate());
      return xml.slice(properties.start, change.start) + opening + xml.slice(change.openEnd, properties.end);
    };
    const opening = xml.slice(run.start, run.openEnd).replace(/\/>$/, '>');
    const parts: Array<{ xml: string; key: number; neutral?: boolean }> = [];
    for (const child of run.children) {
      if (child === properties) continue;
      const spans = covered.get(child);
      if (w(child, 't') && spans) {
        const value = wordElementText(xml, child); const cuts = [...spans].sort((left, right) => left.from - right.from); let offset = 0;
        const element = (part: string, deleted: boolean) => {
          const local = deleted ? 'delText' : 't'; const name = child.tag.prefix ? `${child.tag.prefix}:${local}` : local;
          const start = officeXmlOpening(xml.slice(child.start, child.openEnd).replace(/\/>$/, '>'), 'xml:space', 'preserve').replace(/^<[^\s/>]+/, `<${name}`);
          return `${start}${escapeWordText(part)}</${name}>`;
        };
        for (const cut of cuts) {
          if (cut.from > offset) parts.push({ xml: element(value.slice(offset, cut.from), false), key: -1 });
          parts.push({ xml: element(value.slice(cut.from, cut.to), true), key: cut.match }); offset = cut.to;
        }
        if (offset < value.length) parts.push({ xml: element(value.slice(offset), false), key: -1 });
        continue;
      }
      const whole = spans?.[0]?.match;
      parts.push({ xml: xml.slice(child.start, child.end), key: whole ?? -1, neutral: whole === undefined && w(child, 'lastRenderedPageBreak') });
    }
    for (let index = 0; index < parts.length; index++) if (parts[index].neutral) parts[index].key = parts[index - 1]?.key ?? parts[index + 1]?.key ?? -1;
    const insideOwnInsert = ancestorsTo(run, structuralParagraph(run) ?? run).some(element => w(element, 'ins') && own(element, session));
    let output = ''; let index = 0;
    while (index < parts.length) {
      const key = parts[index].key; let content = '';
      while (index < parts.length && parts[index].key === key) content += parts[index++].xml;
      if (key < 0) { output += `${opening}${rPr()}${content}</${run.tag.name}>`; continue; }
      if (!insideOwnInsert) { output += `${wordRevisionOpening('del', run, session)}${opening}${rPr()}${content}</${run.tag.name}></${wordNames(run).element('del')}>`; revisions++; }
      const isLast = lastRun.get(key) === run && !parts.slice(index).some(part => part.key === key);
      if (isLast && normalized) { output += insideOwnInsert ? newRun(key) : `${wordRevisionOpening('ins', run, session)}${newRun(key)}</${wordNames(run).element('ins')}>`; if (!insideOwnInsert) revisions++; }
    }
    patches.push({ start: run.start, end: run.end, text: output });
  }
  const chunks: string[] = []; let cursor = 0;
  for (const patch of patches) { chunks.push(xml.slice(cursor, patch.start), patch.text); cursor = patch.end; }
  chunks.push(xml.slice(cursor)); const output = encodeOfficeXml({ ...parsed.decoded, xml: chunks.join('') });
  const expected = all ? text.split(find).join(normalized) : text.replace(find, () => normalized);
  if (wordCurrentTargetText(output, target, progress) !== expected) return fail('edited-text-check-failed');
  return { bytes: output, replacements: starts.length, revisions };
}
const structuralParagraph = (element: OfficeXmlElement) => { for (let at = element.parent; at; at = at.parent) if (w(at, 'p')) return at; return undefined; };

/**
 * Marks paragraphs a structural insert just created as inserted: their runs in w:ins and their paragraph marks inserted.
 * The first `fixed` paragraphs (table cells) always carry their own inserted mark; they go with their inserted row.
 */
export function trackInsertedParagraphs(bytes: Buffer, first: number, count: number, session: WordTrackingSession, progress: () => void, fixed = 0) {
  const parsed = officeXmlElements(bytes, progress); const xml = parsed.decoded.xml; const paragraphs = wordBodyParagraphs(parsed);
  const inserted = paragraphs.slice(first - 1, first - 1 + count); if (inserted.length !== count) return fail('office-output-check-failed');
  const patches: Patch[] = [];
  const markParagraph = (paragraph: OfficeXmlElement) => {
    const properties = paragraph.children.find(child => w(child, 'pPr'));
    const name = wordNames(paragraph); const marker = wordRevisionOpening('ins', paragraph, session, true);
    if (paragraph.tag.isSelfClosing) { patches.push({ start: paragraph.start, end: paragraph.end, text: xml.slice(paragraph.start, paragraph.end).replace(/\s*\/>$/, '>')
      + `<${name.element('pPr')}${name.declare}><${name.element('rPr')}${name.declare}>${marker}</${name.element('rPr')}></${name.element('pPr')}></${paragraph.tag.name}>` }); return; }
    if (!properties) { patches.push({ start: paragraph.openEnd, end: paragraph.openEnd, order: -1, text: `<${name.element('pPr')}${name.declare}><${name.element('rPr')}${name.declare}>${marker}</${name.element('rPr')}></${name.element('pPr')}>` }); return; }
    const runProperties = properties.children.find(child => w(child, 'rPr'));
    if (runProperties?.children.some(child => w(child) && containers.has(child.tag.local))) return fail('overlaps-foreign-revision');
    if (runProperties) {
      patches.push(runProperties.tag.isSelfClosing ? { start: runProperties.start, end: runProperties.end, text: xml.slice(runProperties.start, runProperties.end).replace(/\s*\/>$/, '>') + marker + `</${runProperties.tag.name}>` }
        : { start: runProperties.openEnd, end: runProperties.openEnd, text: marker });
      return;
    }
    const rPr = `<${name.element('rPr')}${name.declare}>${marker}</${name.element('rPr')}>`;
    if (properties.tag.isSelfClosing) { patches.push({ start: properties.start, end: properties.end, text: xml.slice(properties.start, properties.end).replace(/\s*\/>$/, '>') + rPr + `</${properties.tag.name}>` }); return; }
    // Paragraph-mark run properties precede a section break and the paragraph property history in w:pPr.
    const after = properties.children.find(child => w(child, 'sectPr') || w(child, 'pPrChange'));
    const at = after?.start ?? xml.lastIndexOf('</', properties.end - 1); patches.push({ start: at, end: at, text: rPr });
  };
  const flowing = inserted.slice(fixed); const marks = inserted.slice(0, fixed);
  if (flowing.length) {
    // A mark at the end of its container cannot be rejected by joining the paragraph to a following one. The paragraph
    // before the block then carries an inserted mark instead, as Word records a new last paragraph.
    const last = flowing.at(-1)!; const siblings = last.parent!.children; const laterParagraph = siblings.slice(siblings.indexOf(last) + 1).some(sibling => w(sibling, 'p'));
    const before = paragraphs[first - 2];
    if (laterParagraph) marks.push(...flowing);
    else if (before && before.parent === last.parent) marks.push(before, ...flowing.slice(0, -1));
    else return fail('edit-not-trackable');
  }
  for (const paragraph of inserted) for (const run of paragraph.children.filter(child => w(child, 'r'))) {
    patches.push({ start: run.start, end: run.start, order: 1, text: wordRevisionOpening('ins', run, session) }, { start: run.end, end: run.end, text: `</${wordNames(run).element('ins')}>` });
  }
  for (const paragraph of marks) markParagraph(paragraph);
  return applyPatches(parsed, patches);
}

/** Marks a table a structural insert just created as inserted: each row, each cell paragraph and a trailing paragraph. */
export function trackInsertedTable(bytes: Buffer, tableOrdinal: number, paragraphFirst: number, paragraphCount: number, cellParagraphs: number, session: WordTrackingSession, progress: () => void) {
  const parsed = officeXmlElements(bytes, progress); const xml = parsed.decoded.xml;
  const table = parsed.elements.filter(element => w(element, 'tbl') && withinWordBody(element))[tableOrdinal - 1]; if (!table) return fail('office-output-check-failed');
  const patches: Patch[] = [];
  for (const row of table.children.filter(child => w(child, 'tr'))) {
    const properties = row.children.find(child => w(child, 'trPr')); const marker = wordRevisionOpening('ins', row, session, true); const name = wordNames(row);
    if (properties) patches.push({ start: xml.lastIndexOf('</', properties.end - 1), end: xml.lastIndexOf('</', properties.end - 1), text: marker });
    else patches.push({ start: row.openEnd, end: row.openEnd, text: `<${name.element('trPr')}${name.declare}>${marker}</${name.element('trPr')}>` });
  }
  return trackInsertedParagraphs(applyPatches(parsed, patches), paragraphFirst, paragraphCount, session, progress, cellParagraphs);
}
/** Insertions at one offset apply in `order` (paragraph properties, then a closing wrapper, then an opening one). */
type Patch = { start: number; end: number; text: string; order?: number };
function applyPatches(parsed: OfficeXmlDocument, patches: Patch[]) {
  const xml = parsed.decoded.xml; const chunks: string[] = []; let cursor = 0;
  for (const patch of [...patches].sort((left, right) => left.start - right.start || (left.order ?? 0) - (right.order ?? 0) || left.end - right.end)) {
    if (patch.start < cursor) return fail('unsupported-package-preservation'); chunks.push(xml.slice(cursor, patch.start), patch.text); cursor = patch.end;
  }
  chunks.push(xml.slice(cursor)); return encodeOfficeXml({ ...parsed.decoded, xml: chunks.join('') });
}

/**
 * Tracked whole-region assignment (set_control_text / set_bookmark_text): the region's current text is deleted and the new text
 * inserted, inside one paragraph only. An empty region inside a paragraph gets the inserted run at its start. A control
 * showing its placeholder, several paragraphs or a region outside a paragraph cannot be recorded as one tracked change.
 */
export function trackedAssignRegion(bytes: Buffer, ref: string, value: string, session: WordTrackingSession, progress: () => void) {
  const parsed = officeXmlElements(bytes, progress); const xml = parsed.decoded.xml; const target: WordTrackedTarget = { kind: 'region', ref };
  let span: ReturnType<typeof officeWordRegionSpan>;
  // A control without exactly one content element would need new structure: not a single tracked change in v1.
  try { span = officeWordRegionSpan(xml, ref, progress); }
  catch (error) { if (ref.startsWith('C') && error instanceof OfficeEditFailure && error.message === 'unsupported-word-region') return fail('edit-not-trackable'); throw error; }
  const selected = scope(parsed, target, progress); const normalized = value.replace(/\r\n?/g, '\n');
  if (selected.paragraphs.length > 1) return fail('edit-not-trackable');
  const content = ref.startsWith('C') ? parsed.elements.find(element => w(element, 'sdtContent') && element.openEnd === span.start) : undefined;
  const bindingPresent = !!content?.parent?.children.find(child => w(child, 'sdtPr'))?.children.some(child => w(child, 'dataBinding'));
  if (content && content.parent?.children.find(child => w(child, 'sdtPr'))?.children.some(child => w(child, 'showingPlcHdr'))) return fail('edit-not-trackable');
  const current = wordCurrentPieces(selected.paragraphs, xml, selected.inside, selected.overlaps);
  if (current.some(piece => piece.boundary)) return fail('edit-not-trackable');
  const text = current.map(piece => piece.text).join('');
  if (text) return { bytes: trackedReplaceText(bytes, target, text, normalized, false, session, progress).bytes, characters: normalized.length, bindingPresent };
  if (!normalized) return { bytes: Buffer.from(bytes), characters: 0, bindingPresent };
  let at: number | undefined; let near: OfficeXmlElement | undefined;
  if (content) {
    const paragraph = content.children.filter(child => w(child, 'p'));
    if (structuralParagraph(content) && !paragraph.length && !content.tag.isSelfClosing) { at = content.openEnd; near = content; }
    else if (paragraph.length === 1 && !paragraph[0].tag.isSelfClosing && content.children.length === 1) { at = xml.lastIndexOf('</', paragraph[0].end - 1); near = paragraph[0]; }
  } else {
    const start = parsed.elements.find(element => w(element, 'bookmarkStart') && element.end === span.start);
    if (start && structuralParagraph(start)) { at = span.start; near = start; }
  }
  if (at === undefined || !near) return fail('edit-not-trackable');
  const name = wordNames(near); const run = `<${name.element('r')}${name.declare}>${wordRunContent(normalized, near)}</${name.element('r')}>`;
  const output = applyPatches(parsed, [{ start: at, end: at, text: `${wordRevisionOpening('ins', near, session)}${run}</${name.element('ins')}>` }]);
  if (wordCurrentTargetText(output, target, progress) !== normalized) return fail('edited-text-check-failed');
  return { bytes: output, characters: normalized.length, bindingPresent };
}

export interface WordDecisionResult { bytes: Buffer; removedParagraphs: number[]; removedRows: Array<{ table: number; row: number }> }
/**
 * Accept or reject one inspected revision group, identified by its Word IDs, kind and author in the current part.
 * Only decidable groups (insert/delete, not nested, whole paragraphs and rows) are applied.
 */
export function decideWordRevision(bytes: Buffer, identity: { wordIds: Array<string | null>; kind: string; author: string | null }, decision: 'accept' | 'reject', progress: () => void): WordDecisionResult {
  const parsed = officeXmlElements(bytes, progress); const xml = parsed.decoded.xml;
  const model = wordStoryModelFromXml(xml, 'main', progress);
  const wanted = JSON.stringify(identity.wordIds);
  const group: WordRevisionGroup | undefined = model.groups.find(candidate => JSON.stringify(candidate.items.map(item => item.wordId ?? null)) === wanted
    && candidate.kind === identity.kind && (candidate.author || null) === identity.author);
  if (!group) return fail('edit-target-unavailable');
  if (!group.decidable) return fail('revision-not-decidable');
  const byStart = new Map(parsed.elements.map(element => [element.start, element]));
  const paragraphs = wordBodyParagraphs(parsed); const tables = parsed.elements.filter(element => w(element, 'tbl') && withinWordBody(element));
  const patches: Patch[] = []; const removed: OfficeXmlElement[] = [];
  const removedParagraphs: number[] = []; const removedRows: Array<{ table: number; row: number }> = [];
  const keepContent = decision === 'accept' ? group.kind === 'insert' : group.kind === 'delete';
  for (const item of group.items) {
    const element = byStart.get(item.node.start); if (!element) return fail('office-output-check-failed');
    if (item.scope === 'inline') {
      if (!keepContent) { removed.push(element); continue; }
      const close = element.tag.isSelfClosing ? element.end : xml.lastIndexOf('</', element.end - 1);
      patches.push({ start: element.start, end: element.openEnd, text: '' }); if (!element.tag.isSelfClosing) patches.push({ start: close, end: element.end, text: '' });
      if (group.kind === 'delete') for (const text of wordDescendants(element)) {
        if (!w(text, 'delText') && !w(text, 'delInstrText')) continue;
        const local = text.tag.local === 'delText' ? 't' : 'instrText'; const name = text.tag.prefix ? `${text.tag.prefix}:${local}` : local;
        patches.push({ start: text.start, end: text.start + 1 + text.tag.name.length, text: `<${name}` });
        if (!text.tag.isSelfClosing) { const end = xml.lastIndexOf('</', text.end - 1); patches.push({ start: end, end: text.end, text: `</${name}>` }); }
      }
    } else if (item.scope === 'paragraph-mark') {
      const paragraph = element.parent!.parent!.parent!;
      if (keepContent) removed.push(element);
      else { removed.push(paragraph); removedParagraphs.push(paragraphs.indexOf(paragraph) + 1); }
    } else if (item.scope === 'table-row') {
      const row = element.parent!.parent!;
      if (keepContent) removed.push(element);
      else {
        removed.push(row); removedRows.push({ table: tables.indexOf(row.parent!) + 1, row: row.parent!.children.filter(child => w(child, 'tr')).indexOf(row) + 1 });
        for (const paragraph of paragraphs) if (paragraph.start > row.start && paragraph.end <= row.end) removedParagraphs.push(paragraphs.indexOf(paragraph) + 1);
      }
    }
  }
  for (const element of removed) patches.push({ start: element.start, end: element.end, text: '' });
  const outer = patches.filter(patch => !patches.some(other => other !== patch && other.text === '' && other.start <= patch.start && other.end >= patch.end && (other.start < patch.start || other.end > patch.end)));
  const output = applyPatches(parsed, outer);
  return { bytes: output, removedParagraphs: [...new Set(removedParagraphs)].sort((a, b) => a - b), removedRows };
}
