// inspect_office records for Word revisions and comments. A damaged optional comment part never fails the inventory.
import type { OfficePackage, OfficePart } from '../OfficePackage';
import type { OfficeRecord } from '../OfficeInventory';
import { wordStoryModel, type WordRevisionGroup, type WordStoryModel } from './WordRevisionModel';
import { wordComments, WORD_COMMENT_PARTS, type WordComment, type WordCommentPartKey, type WordCommentSet } from './WordComments';
import { wordParagraphLayout, wordParagraphText } from './WordRevisionViews';

export type WordStoryKind = 'main' | 'header' | 'footer';
export interface WordRevisionRead {
  models: Map<string, WordStoryModel>; comments?: WordCommentSet; commentRefs: Map<string, string>; gaps: Array<{ id: string; code: string; part?: string }>;
}
async function partBytes(pkg: OfficePackage, name: string, progress: () => void) {
  const chunks: Buffer[] = []; for await (const chunk of pkg.zip.bytes(name)) { progress(); chunks.push(Buffer.from(chunk)); } return Buffer.concat(chunks);
}
/** Comment part targets of the main document, by relationship type. Unknown or external targets are ignored. */
export async function wordCommentPartNames(pkg: OfficePackage): Promise<Partial<Record<WordCommentPartKey, string>>> {
  const found: Partial<Record<WordCommentPartKey, string>> = {};
  for (const relation of await pkg.relations(pkg.main.name)) {
    if (relation.external || !relation.target || !pkg.part(relation.target)) continue;
    for (const [key, definition] of Object.entries(WORD_COMMENT_PARTS) as Array<[WordCommentPartKey, typeof WORD_COMMENT_PARTS[WordCommentPartKey]]>) {
      const types: string[] = [definition.type, ...('strictType' in definition ? [definition.strictType] : [])];
      if (types.includes(relation.type) && !found[key]) found[key] = relation.target;
    }
  }
  return found;
}

export async function readWordRevisions(pkg: OfficePackage, stories: Array<{ part: OfficePart; story: WordStoryKind }>, progress: () => void): Promise<WordRevisionRead> {
  const models = new Map<string, WordStoryModel>(); const gaps: WordRevisionRead['gaps'] = [];
  for (const { part, story } of stories) {
    try { models.set(part.ref, wordStoryModel(await partBytes(pkg, part.name, progress), story, progress)); }
    catch { gaps.push({ id: `${story === 'main' ? 'document' : part.ref}-revisions`, code: 'unsupported-revision-structure', part: part.ref }); }
  }
  let comments: WordCommentSet | undefined;
  const names = await wordCommentPartNames(pkg);
  if (names.comments) {
    try {
      const read = async (key: WordCommentPartKey) => { const name = names[key]; return name ? await partBytes(pkg, name, progress) : undefined; };
      comments = wordComments({ comments: await read('comments'), extended: await read('extended'), ids: await read('ids'), extensible: await read('extensible'), people: await read('people') }, progress);
    } catch { gaps.push({ id: 'comments', code: 'word-comments-unavailable', part: pkg.part(names.comments)?.ref }); }
  }
  const commentRefs = new Map<string, string>();
  comments?.comments.forEach((comment, index) => { if (!commentRefs.has(comment.id)) commentRefs.set(comment.id, `M${index + 1}`); });
  return { models, comments, commentRefs, gaps };
}

/** View fields stored on a paragraph record; the page projects the requested view into the text field. */
export function wordParagraphViewFields(model: WordStoryModel | undefined, ordinal: number, commentRefs: Map<string, string>): Record<string, unknown> | undefined {
  const paragraph = model?.paragraphs[ordinal - 1]; if (!paragraph || !paragraph.revised && !paragraph.commented) return undefined;
  const reference = (id: string) => commentRefs.get(id);
  const views: Record<string, unknown> = { original: wordParagraphText(paragraph, 'original'), markup: wordParagraphText(paragraph, 'markup', reference) };
  for (const view of ['current', 'original'] as const) {
    const layout = wordParagraphLayout(paragraph, view);
    if (layout.joinsNext) views[`${view}_joins_next`] = true; if (layout.omitted) views[`${view}_omitted`] = true;
  }
  return { text: paragraph.current, views };
}

export function wordRevisionRecords(model: WordStoryModel, snapshot: string, part: OfficePart): OfficeRecord[] {
  const ref = (group: WordRevisionGroup) => `R${group.ordinal}`;
  return model.groups.map(group => ({ kind: 'revision', id: ref(group), record: { revision_ref: ref(group), part_ref: part.ref, selector: { snapshot_ref: snapshot, revision_ref: ref(group) },
    kind: group.kind, author: group.author || null, date: group.date || null, word_id: group.items[0].wordId ?? null,
    ...(group.items.length > 1 ? { word_ids: group.items.map(item => item.wordId ?? null) } : {}),
    story_ref: part.ref, paragraph_refs: group.paragraphs.map(ordinal => `D${ordinal}`), text: group.text,
    ...(group.structure ? { structure: group.structure } : {}), ...(group.nestedIn ? { nested_in: ref(group.nestedIn) } : {}), decidable: group.decidable } }));
}

interface Anchor { story_ref: string; start_paragraph_ref: string; end_paragraph_ref: string; text: string }
/** One record per comments.xml entry; damaged anchors are reported as gaps without hiding the comment. */
export function wordCommentRecords(read: WordRevisionRead, snapshot: string, stories: Array<{ part: OfficePart; story: WordStoryKind }>, commentsPart: string | undefined) {
  const records: OfficeRecord[] = []; const gaps: WordRevisionRead['gaps'] = []; const set = read.comments; if (!set) return { records, gaps };
  const known = new Set(set.comments.map(comment => comment.id));
  for (const { part, story } of stories) {
    const model = read.models.get(part.ref);
    for (const mark of model?.comments ?? []) if (!known.has(mark.id)) gaps.push({ id: `${story === 'main' ? '' : part.ref + '-'}comment-id-${mark.id}`, code: 'unsupported-revision-structure', part: part.ref });
  }
  const anchor = (comment: WordComment): Anchor | null | undefined => {
    for (const { part, story } of stories) {
      const model = read.models.get(part.ref); if (!model) continue;
      const marks = model.comments.filter(mark => mark.id === comment.id); if (!marks.length) continue;
      const starts = marks.filter(mark => mark.type === 'start'); const ends = marks.filter(mark => mark.type === 'end'); const references = marks.filter(mark => mark.type === 'reference');
      const prefix = story === 'main' ? '' : part.ref + '-';
      if (starts.length > 1 || ends.length > 1 || starts.length !== ends.length || !references.length) return null;
      if (!starts.length) {
        const at = references[0].paragraph; if (!at) return null;
        return { story_ref: part.ref, start_paragraph_ref: `${prefix}D${at}`, end_paragraph_ref: `${prefix}D${at}`, text: '' };
      }
      const start = starts[0]; const end = ends[0]; if (!start.paragraph || !end.paragraph || end.paragraph < start.paragraph || end.paragraph === start.paragraph && end.offset < start.offset) return null;
      const texts = model.paragraphs.slice(start.paragraph - 1, end.paragraph).map(paragraph => paragraph.current);
      const text = texts.length === 1 ? texts[0].slice(start.offset, end.offset) : [texts[0].slice(start.offset), ...texts.slice(1, -1), texts.at(-1)!.slice(0, end.offset)].join('\n');
      return { story_ref: part.ref, start_paragraph_ref: `${prefix}D${start.paragraph}`, end_paragraph_ref: `${prefix}D${end.paragraph}`, text };
    }
    return undefined;
  };
  set.comments.forEach((comment, index) => {
    const ref = `M${index + 1}`; const located = anchor(comment); const parent = set.parent(comment);
    if (!located) gaps.push({ id: `${ref}-anchor`, code: 'unsupported-revision-structure', ...(commentsPart ? { part: commentsPart } : {}) });
    records.push({ kind: 'comment', id: ref, record: { comment_ref: ref, ...(commentsPart ? { part_ref: commentsPart } : {}), selector: { snapshot_ref: snapshot, comment_ref: ref },
      word_id: comment.id, author: comment.author || null, initials: comment.initials || null, date: comment.date || null, text: comment.text,
      ...(parent ? { parent_ref: read.commentRefs.get(parent.id) } : {}), resolved: set.resolved(comment), anchor: located ?? null } });
  });
  return { records, gaps };
}
