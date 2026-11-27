// Word comments: comments.xml plus the optional Microsoft thread metadata parts. Pure JavaScript.
import { officeXmlElements, type OfficeXmlDocument, type OfficeXmlElement } from '../OfficeXmlElements';
import { attributeIn, isWordElement as isWord, wordAttribute, wordDescendants as descendants, wordElementText } from './WordXml';

export const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
export const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml';
export const W16CID = 'http://schemas.microsoft.com/office/word/2016/wordml/cid';
export const W16CEX = 'http://schemas.microsoft.com/office/word/2018/wordml/cex';
/** Relationship types and content types of the comment parts (checked against a Word 16 saved file for the first three). */
export const WORD_COMMENT_PARTS = {
  comments: { type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments', strictType: 'http://purl.oclc.org/ooxml/officeDocument/relationships/comments',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml', member: 'comments.xml' },
  extended: { type: 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml', member: 'commentsExtended.xml' },
  ids: { type: 'http://schemas.microsoft.com/office/2016/09/relationships/commentsIds', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsIds+xml', member: 'commentsIds.xml' },
  extensible: { type: 'http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtensible+xml', member: 'commentsExtensible.xml' },
  people: { type: 'http://schemas.microsoft.com/office/2011/relationships/people', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml', member: 'people.xml' },
} as const;
export type WordCommentPartKey = keyof typeof WORD_COMMENT_PARTS;

export interface WordCommentParagraph { element: OfficeXmlElement; paraId?: string; text: string }
export interface WordComment {
  id: string; author: string; initials: string; date: string; element: OfficeXmlElement; paragraphs: WordCommentParagraph[]; text: string;
  /** commentEx/@paraId: the comment's last paragraph identity. */ lastParaId?: string;
  extended?: { element: OfficeXmlElement; parentParaId?: string; done?: string };
}
export interface WordCommentSet {
  comments: WordComment[]; parsed?: OfficeXmlDocument; extended?: OfficeXmlDocument; ids?: OfficeXmlDocument; extensible?: OfficeXmlDocument; people?: OfficeXmlDocument;
  parent(comment: WordComment): WordComment | undefined; root(comment: WordComment): WordComment; resolved(comment: WordComment): boolean | null;
}

function paragraphText(xml: string, paragraph: OfficeXmlElement): string {
  let text = '';
  const visit = (element: OfficeXmlElement, removed: boolean) => {
    for (const child of element.children) {
      if (isWord(child, 'p')) continue;
      const gone = removed || isWord(child, 'del') || isWord(child, 'moveFrom');
      if (isWord(child, 't') && isWord(child.parent, 'r') && !gone) text += wordElementText(xml, child);
      else if ((isWord(child, 'tab')) && isWord(child.parent, 'r') && !gone) text += '\t';
      else if ((isWord(child, 'br') || isWord(child, 'cr')) && isWord(child.parent, 'r') && !gone) text += '\n';
      else visit(child, gone);
    }
  };
  visit(paragraph, false); return text;
}

/** Parses supplied comment parts. Any metadata part that cannot be parsed is reported as absent by the caller. */
export function wordComments(parts: { comments?: Buffer; extended?: Buffer; ids?: Buffer; extensible?: Buffer; people?: Buffer }, progress: () => void = () => {}): WordCommentSet {
  const comments: WordComment[] = [];
  const parsed = parts.comments ? officeXmlElements(parts.comments, progress) : undefined;
  if (parsed) {
    const root = parsed.elements[0]; if (!isWord(root, 'comments')) throw new Error('unsupported-revision-structure');
    for (const element of root.children) if (isWord(element, 'comment')) {
      const paragraphs = [...descendants(element)].filter(child => isWord(child, 'p')).map(paragraph => ({ element: paragraph, paraId: attributeIn(paragraph, W14, 'paraId'),
        text: paragraphText(parsed.decoded.xml, paragraph) }));
      comments.push({ id: wordAttribute(element, 'id') ?? '', author: wordAttribute(element, 'author') ?? '', initials: wordAttribute(element, 'initials') ?? '',
        date: wordAttribute(element, 'date') ?? '', element, paragraphs, text: paragraphs.map(paragraph => paragraph.text).join('\n'), lastParaId: paragraphs.at(-1)?.paraId });
    }
  }
  const extended = parts.extended ? officeXmlElements(parts.extended, progress) : undefined;
  if (extended) {
    const root = extended.elements[0]; if (root.tag.uri !== W15 || root.tag.local !== 'commentsEx') throw new Error('unsupported-revision-structure');
    const byPara = new Map(comments.filter(comment => comment.lastParaId).map(comment => [comment.lastParaId!, comment]));
    for (const element of root.children) if (element.tag.uri === W15 && element.tag.local === 'commentEx') {
      const comment = byPara.get(attributeIn(element, W15, 'paraId') ?? '');
      if (comment && !comment.extended) comment.extended = { element, parentParaId: attributeIn(element, W15, 'paraIdParent'), done: attributeIn(element, W15, 'done') };
    }
  }
  const optional = (bytes: Buffer | undefined) => bytes ? officeXmlElements(bytes, progress) : undefined;
  const byLast = new Map(comments.filter(comment => comment.lastParaId).map(comment => [comment.lastParaId!, comment]));
  const parent = (comment: WordComment) => comment.extended?.parentParaId ? byLast.get(comment.extended.parentParaId) : undefined;
  const root = (comment: WordComment) => { const seen = new Set<WordComment>(); let at = comment; while (!seen.has(at)) { seen.add(at); const next = parent(at); if (!next) break; at = next; } return at; };
  return { comments, parsed, extended, ids: optional(parts.ids), extensible: optional(parts.extensible), people: optional(parts.people), parent, root,
    resolved: comment => { if (!extended) return null; const top = root(comment); const done = top.extended?.done ?? comment.extended?.done; return done === undefined ? null : done === '1' || done === 'true'; } };
}
