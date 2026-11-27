// Revision-aware model of one Word story part (body, header or footer). Pure JavaScript, no application.
// One streaming pass: only revision items, paragraphs and their byte offsets are kept, never the whole element tree.
// Paragraph ordinals follow the inventory rule: every WordprocessingML w:p inside the story, in document order,
// excluding markup-compatibility alternatives.
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { OFFICE_NS } from '../OfficePackage';
import { decodeOfficeXml } from '../OfficeTextPatch';

export type WordRevisionKind = 'insert' | 'delete' | 'move-from' | 'move-to' | 'format-run' | 'format-paragraph' | 'other';
export type WordRevisionScope = 'inline' | 'paragraph-mark' | 'table-row' | 'property' | 'other';
/** Offsets in the decoded XML string: start of the opening tag, end of the opening tag, end of the element. */
export interface WordNode { local: string; start: number; openEnd: number; end: number }
export interface WordRevisionItem {
  node: WordNode; kind: WordRevisionKind; scope: WordRevisionScope; author: string; date: string; wordId?: string;
  paragraph?: number; parentItem?: WordRevisionItem; children: WordRevisionItem[]; group?: WordRevisionGroup; hasMarker: boolean; row?: WordRow;
  /** For a run property change: the stored text of that run. */ runText?: string;
  /** Text inside this container, including nested revisions. */ text: string;
}
export interface WordRevisionGroup {
  ordinal: number; kind: WordRevisionKind; author: string; date: string; items: WordRevisionItem[]; paragraphs: number[];
  text: string; nestedIn?: WordRevisionGroup; decidable: boolean; structure?: 'table-row' | 'paragraph-mark';
}
export interface WordRow { node: WordNode; table: { rows: number }; paragraphs: WordParagraph[]; hasTable: boolean; hasMarker: boolean; item?: WordRevisionItem }
export type WordMarkupToken = string | { comment: string };
export interface WordParagraph {
  ordinal: number; node: WordNode; current: string; original: string; markup: WordMarkupToken[];
  /** Only with keepPieces: each text unit with its revision containers, for per-request projections. */ pieces?: Array<{ text: string; stack: WordRevisionItem[]; delText: boolean }>;
  /** Text of every w:t, Tab and break, as the stored inventory reads it. */ stored: string;
  mark?: WordRevisionItem; row?: WordRow; revised: boolean; commented: boolean;
  /** Structure facts used to decide whether the whole paragraph can be removed by an accept or reject. */
  foreign: boolean; sectPr: boolean; inline: WordRevisionItem[]; laterSibling: boolean; hasMarker: boolean; nestedParagraph: boolean;
}
export interface WordCommentMark { id: string; type: 'start' | 'end' | 'reference'; paragraph?: number; offset: number; node: WordNode }
export interface WordStoryModel { xml: string; paragraphs: WordParagraph[]; items: WordRevisionItem[]; groups: WordRevisionGroup[]; comments: WordCommentMark[]; paragraphCount: number }

const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const isW = (tag: SaxesTagNS | undefined, local?: string) => !!tag && OFFICE_NS.w.includes(tag.uri) && (local === undefined || tag.local === local);
export const wordTagAttribute = (tag: SaxesTagNS, local: string) => {
  for (const attribute of Object.values(tag.attributes)) if (attribute.local === local && OFFICE_NS.w.includes(attribute.uri)) return attribute.value;
  return undefined;
};
const containers: Record<string, WordRevisionKind> = { ins: 'insert', del: 'delete', moveFrom: 'move-from', moveTo: 'move-to' };
const otherChanges = new Set(['sectPrChange', 'tblPrChange', 'tblPrExChange', 'trPrChange', 'tcPrChange', 'tblGridChange', 'numberingChange', 'cellIns', 'cellDel', 'cellMerge',
  'customXmlInsRangeStart', 'customXmlDelRangeStart', 'customXmlMoveFromRangeStart', 'customXmlMoveToRangeStart']);
/** Markers whose partner may lie outside a removed element; their presence makes a structural decision unsafe. */
const pairedMarkers = new Set(['bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd', 'commentReference', 'moveFromRangeStart', 'moveFromRangeEnd',
  'moveToRangeStart', 'moveToRangeEnd', 'fldChar', 'permStart', 'permEnd']);
export class WordRevisionStructureError extends Error { constructor() { super('unsupported-revision-structure'); } }
export const escapeMarkupAuthor = (author: string) => author.replaceAll(']', '\\]').replaceAll(':', '\\:');
const symbol: Partial<Record<WordRevisionKind, string>> = { insert: '+', delete: '-', 'move-to': '>', 'move-from': '<' };

interface Frame {
  tag: SaxesTagNS; node: WordNode; parent?: Frame; body: boolean; skip: boolean; paragraph?: WordParagraph; ownParagraph?: WordParagraph;
  stack: WordRevisionItem[]; item?: WordRevisionItem; row?: WordRow; ownRow?: WordRow; table?: { rows: number }; hasMarker: boolean;
  pending: WordParagraph[]; text?: 't' | 'delText'; value: string; format?: WordRevisionItem;
}

/** retain=false keeps only revision groups (counts and authors), for bounded plain-text reads. */
export function wordStoryModelFromXml(xml: string, story: 'main' | 'header' | 'footer', progress: () => void = () => {}, retain = true, keepPieces = false): WordStoryModel {
  const parser = new SaxesParser({ xmlns: true });
  const paragraphs: WordParagraph[] = []; const items: WordRevisionItem[] = []; const comments: WordCommentMark[] = []; const groups: WordRevisionGroup[] = [];
  const pendingStarts: WordCommentMark[] = []; const ended = new Set<string>(); const frames: Frame[] = []; let start = 0; let paragraphCount = 0; let lastParagraph: WordParagraph | undefined;
  let open: WordRevisionGroup | undefined;
  const groupable = (entry: WordRevisionItem) => (entry.kind === 'insert' || entry.kind === 'delete') && !entry.parentItem && !entry.children.length;
  const create = (entry: WordRevisionItem) => {
    const group: WordRevisionGroup = { ordinal: 0, kind: entry.kind, author: entry.author, date: entry.date, items: [entry], paragraphs: [], text: '', decidable: false };
    entry.group = group; groups.push(group); return group;
  };
  // Word groups adjacent changes of one kind, author and date into one revision; unrevised text or a paragraph mark ends a group.
  const unit = (entry: WordRevisionItem | undefined, text: string, paragraph: WordParagraph | undefined) => {
    if (!entry) { open = undefined; return; }
    let group = entry.group;
    if (!group) {
      // An item can gain children after its first unit only when nested; nesting is settled when grouping is final.
      if (open && groupable(entry) && groupable(open.items[0]) && open.kind === entry.kind && open.author === entry.author && open.date === entry.date) { group = open; group.items.push(entry); entry.group = group; }
      else group = create(entry);
    }
    open = group;
    if (retain) { group.text += text; if (paragraph && !group.paragraphs.includes(paragraph.ordinal)) group.paragraphs.push(paragraph.ordinal); }
  };
  const item = (frame: Frame, kind: WordRevisionKind, scope: WordRevisionScope, paragraph?: WordParagraph, parentItem?: WordRevisionItem): WordRevisionItem => {
    const made: WordRevisionItem = { node: frame.node, kind, scope, author: wordTagAttribute(frame.tag, 'author') ?? '', date: wordTagAttribute(frame.tag, 'date') ?? '',
      wordId: wordTagAttribute(frame.tag, 'id'), paragraph: paragraph?.ordinal, parentItem, children: [], hasMarker: false, text: '' };
    parentItem?.children.push(made); items.push(made); return made;
  };
  parser.on('doctype', () => { throw new WordRevisionStructureError(); });
  parser.on('opentagstart', () => { start = xml.lastIndexOf('<', parser.position - 1); });
  parser.on('opentag', tag => {
    const parent = frames.at(-1); const local = tag.local; const word = isW(tag);
    const frame: Frame = { tag, node: { local, start, openEnd: parser.position, end: parser.position }, parent, body: parent ? parent.body : story !== 'main',
      skip: parent?.skip ?? false, paragraph: parent?.paragraph, stack: parent?.stack ?? [], row: parent?.row, hasMarker: false, pending: [], value: '' };
    frames.push(frame);
    if (!parent && !isW(tag, story === 'main' ? 'document' : story === 'header' ? 'hdr' : 'ftr')) throw new WordRevisionStructureError();
    if (frame.skip) return;
    const paragraph = frame.paragraph; const directChild = !!parent?.ownParagraph;
    if (tag.uri === MC && local === 'AlternateContent') { frame.skip = true; if (directChild) paragraph!.foreign = true; return; }
    if (isW(tag, 'body')) frame.body = true;
    if (!frame.body || !word) { if (directChild) paragraph!.foreign = true; return; }
    progress();
    if (pairedMarkers.has(local)) frame.hasMarker = true;
    if (local === 'p') {
      // A paragraph in an inserted or deleted row is revised by that row even without a revision of its own.
      const created: WordParagraph = { ordinal: ++paragraphCount, node: frame.node, current: '', original: '', stored: '', markup: [], row: frame.row, revised: !!frame.row?.item, commented: false,
        foreign: false, sectPr: false, inline: [], laterSibling: false, hasMarker: false, nestedParagraph: false };
      if (retain) paragraphs.push(created);
      if (paragraph) paragraph.nestedParagraph = true;
      if (parent) { for (const earlier of parent.pending) earlier.laterSibling = true; parent.pending = [created]; }
      frame.row?.paragraphs.push(created);
      for (const pending of pendingStarts.splice(0)) { pending.paragraph = created.ordinal; pending.offset = 0; created.commented = true; }
      frame.paragraph = created; frame.ownParagraph = created; lastParagraph = created; return;
    }
    if (local === 'tbl') { frame.table = { rows: 0 }; if (frame.row) frame.row.hasTable = true; }
    if (local === 'tr') {
      const table = parent?.table ?? { rows: 0 }; table.rows++;
      const row: WordRow = { node: frame.node, table, paragraphs: [], hasTable: false, hasMarker: false }; frame.row = row; frame.ownRow = row;
    }
    if (directChild) {
      if (local === 'pPr' || local === 'proofErr') { /* paragraph properties and proofing marks carry no content */ }
      else if (!containers[local]) paragraph!.foreign = true;
    }
    if (local === 'sectPr' && isW(parent?.tag, 'pPr') && parent!.parent?.ownParagraph) parent!.parent.ownParagraph.sectPr = true;
    if (containers[local]) {
      if (isW(parent?.tag, 'trPr')) {
        const row = parent!.parent?.ownRow;
        if (row && !row.item) { row.item = item(frame, containers[local], 'table-row'); row.item.row = row; unit(row.item, '', undefined); } else item(frame, 'other', 'other', paragraph);
        return;
      }
      if (isW(parent?.tag, 'rPr') && isW(parent!.parent?.tag, 'pPr') && parent!.parent!.parent?.ownParagraph) {
        const owner = parent!.parent!.parent!.ownParagraph!; if (!owner.mark) owner.mark = item(frame, containers[local], 'paragraph-mark', owner); else item(frame, 'other', 'other', owner);
        return;
      }
      if (paragraph && !isW(parent?.tag, 'rPr') && !isW(parent?.tag, 'numPr')) {
        const made = item(frame, containers[local], 'inline', paragraph, frame.stack.at(-1)); paragraph.revised = true;
        if (directChild) paragraph.inline.push(made);
        if (retain) paragraph.markup.push(`[${symbol[made.kind]}${escapeMarkupAuthor(made.author)}: `);
        frame.item = made; frame.stack = [...frame.stack, made]; return;
      }
      if (directChild) paragraph!.foreign = true;
      item(frame, 'other', 'other', paragraph); return;
    }
    if (local === 'rPrChange' || local === 'pPrChange') {
      const made = item(frame, local === 'rPrChange' ? 'format-run' : 'format-paragraph', 'property', paragraph); if (paragraph) paragraph.revised = true; frame.skip = true;
      const run = parent?.parent; if (local === 'rPrChange' && isW(parent?.tag, 'rPr') && run && isW(run.tag, 'r')) { made.runText = ''; run.format = made; }
      return;
    }
    if (otherChanges.has(local)) { item(frame, 'other', 'other', paragraph); if (paragraph) paragraph.revised = true; return; }
    if (paragraph && isW(parent?.tag, 'r')) {
      if (local === 't' || local === 'delText') { frame.text = local; return; }
      if (local === 'tab' || local === 'br' || local === 'cr') { piece(paragraph, local === 'tab' ? '\t' : '\n', local, frame.stack, parent!); return; }
    }
    if (local === 'commentRangeStart' || local === 'commentRangeEnd' || local === 'commentReference') {
      const type = local === 'commentRangeStart' ? 'start' : local === 'commentRangeEnd' ? 'end' : 'reference';
      const mark: WordCommentMark = { id: wordTagAttribute(tag, 'id') ?? '', type, paragraph: paragraph?.ordinal, offset: paragraph?.current.length ?? 0, node: frame.node };
      if (!paragraph && type === 'start') pendingStarts.push(mark);
      if (!paragraph && type !== 'start') { mark.paragraph = lastParagraph?.ordinal; mark.offset = lastParagraph?.current.length ?? 0; }
      // The markup anchor follows the range end, or the reference of a comment whose range end was not seen.
      if (paragraph) { paragraph.commented = true; if (retain && (type === 'end' || type === 'reference' && !ended.has(mark.id))) paragraph.markup.push({ comment: mark.id }); }
      if (type === 'end') ended.add(mark.id);
      comments.push(mark);
    }
  });
  const piece = (paragraph: WordParagraph, text: string, local: string, stack: WordRevisionItem[], run: Frame) => {
    if (run.format && local !== 'delText') run.format.runText += text;
    const removed = local === 'delText' || stack.some(entry => entry.kind === 'delete' || entry.kind === 'move-from');
    const added = stack.some(entry => entry.kind === 'insert' || entry.kind === 'move-to');
    if (retain) {
      if (!removed) paragraph.current += text; if (!added) paragraph.original += text; if (local !== 'delText') paragraph.stored += text;
      paragraph.markup.push(text); for (const entry of stack) entry.text += text;
      if (keepPieces) (paragraph.pieces ??= []).push({ text, stack, delText: local === 'delText' });
    } else if (!removed) paragraph.current += text;
    if (local === 'delText' && !stack.length) paragraph.revised = true;
    if (text) unit(stack.at(-1), text, paragraph);
  };
  const text = (value: string) => { const frame = frames.at(-1); if (frame?.text && !frame.skip) frame.value += value; };
  parser.on('text', text); parser.on('cdata', text);
  parser.on('closetag', () => {
    const frame = frames.pop()!; frame.node.end = parser.position;
    if (frame.parent && frame.hasMarker) frame.parent.hasMarker = true;
    if (frame.skip) return;
    if (frame.text && frame.paragraph) piece(frame.paragraph, frame.value, frame.text, frame.stack, frame.parent!);
    if (frame.item) { frame.item.hasMarker = frame.hasMarker; if (retain) frame.paragraph!.markup.push(']'); }
    if (frame.ownRow) frame.ownRow.hasMarker = frame.hasMarker;
    const paragraph = frame.ownParagraph;
    if (paragraph) {
      paragraph.hasMarker = frame.hasMarker;
      if (paragraph.mark) { paragraph.revised = true; if (retain) paragraph.markup.push(`[${symbol[paragraph.mark.kind] ?? '~'}${escapeMarkupAuthor(paragraph.mark.author)}: ¶]`); }
      if (retain) unit(paragraph.mark, '\n', paragraph); else unit(paragraph.mark, '', undefined);
    }
  });
  for (let at = 0; at < xml.length; at += 65536) { progress(); parser.write(xml.slice(at, at + 65536)); }
  parser.close();
  for (const entry of items) if (!entry.group) {
    const group = create(entry);
    if (retain && entry.paragraph) {
      group.paragraphs.push(entry.paragraph); const paragraph = paragraphs[entry.paragraph - 1];
      if (entry.kind === 'format-paragraph') group.text = paragraph.current;
      if (entry.kind === 'format-run') group.text = entry.runText ?? '';
    }
  }
  groups.sort((left, right) => left.items[0].node.start - right.items[0].node.start);
  groups.forEach((group, index) => { group.ordinal = index + 1; });
  for (const group of groups) {
    const parentItem = group.items[0].parentItem; if (parentItem) group.nestedIn = parentItem.group;
    if (retain && group.items[0].children.length) group.text = group.items[0].text;
    if (group.items.some(entry => entry.scope === 'table-row')) group.structure = 'table-row';
    else if (group.items.every(entry => entry.scope === 'paragraph-mark')) group.structure = 'paragraph-mark';
    if (retain) group.decidable = decidable(group, paragraphs);
  }
  return { xml, paragraphs, items, groups, comments, paragraphCount };
}

/** Whether the host can apply both accept and reject structurally, per the v1 rules (whole paragraphs and rows only). */
function decidable(group: WordRevisionGroup, paragraphs: WordParagraph[]): boolean {
  if (group.kind !== 'insert' && group.kind !== 'delete') return false;
  if (group.items.some(entry => entry.parentItem || entry.children.length)) return false;
  const inGroup = new Set(group.items);
  const owned = (paragraph: WordParagraph) => !paragraph.foreign && !paragraph.sectPr && !paragraph.hasMarker && !paragraph.nestedParagraph && paragraph.inline.every(entry => inGroup.has(entry));
  for (const entry of group.items) {
    if (entry.scope === 'inline' && entry.hasMarker) return false;
    if (entry.scope === 'paragraph-mark') {
      const paragraph = paragraphs[entry.paragraph! - 1]; if (!owned(paragraph)) return false;
      const removedWithRow = !!paragraph.row?.item && inGroup.has(paragraph.row.item);
      if (!removedWithRow && !paragraph.laterSibling) return false;
    }
    if (entry.scope === 'table-row') {
      const row = entry.row!; const removedRows = group.items.filter(other => other.scope === 'table-row' && other.row!.table === row.table).length;
      if (row.table.rows - removedRows < 1 || row.hasTable || row.hasMarker) return false;
      if (row.paragraphs.some(paragraph => !owned(paragraph) || !paragraph.mark || !inGroup.has(paragraph.mark))) return false;
    }
  }
  return true;
}

export function wordStoryModel(bytes: Buffer, story: 'main' | 'header' | 'footer', progress: () => void = () => {}, retain = true): WordStoryModel {
  return wordStoryModelFromXml(decodeOfficeXml(bytes).xml, story, progress, retain);
}
