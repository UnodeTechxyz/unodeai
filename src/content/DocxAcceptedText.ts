import { SaxesParser } from 'saxes';
const WORD = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml';
const revisions = new Set(['ins', 'del', 'moveFrom', 'moveTo', 'rPrChange', 'pPrChange']);
const hidden = new Set(['del', 'moveFrom', 'delText', 'delInstrText']);
/** Elements that may sit between two paragraphs without preventing a removed paragraph mark from joining them. */
const betweenParagraphs = new Set(['bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd', 'permStart', 'permEnd', 'proofErr',
  'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd']);
function scan(parser: SaxesParser<{ xmlns: true }>, xml: string, progress: () => void) {
  parser.on('doctype', () => { throw Error('unsupported-xml-dtd'); });
  for (let at = 0; at < xml.length; at += 65536) { progress(); parser.write(xml.slice(at, at + 65536)); }
  parser.close();
}
export function docxContainsComments(xml: string, progress = () => {}): boolean {
  if (!/<(?:[^\s<>/]+:)?comment(?=[\s/>])/.test(xml)) return false;
  let found = false; const parser = docxCommentParser(() => { found = true; });
  scan(parser, xml, progress); return found;
}
export function docxCommentParser(found: () => void) {
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => { throw Error('unsupported-xml-dtd'); });
  parser.on('opentag', tag => { if (WORD.has(tag.uri) && tag.local === 'comment') found(); }); return parser;
}
/** Streaming comment facts for a plain-text read: the count and each comment's last paragraph identity. No comment text is kept. */
export function docxCommentCollector() {
  const parser = new SaxesParser({ xmlns: true }); const lastParaIds: Array<string | undefined> = []; let depth = 0; let commentDepth = 0;
  parser.on('doctype', () => { throw Error('unsupported-xml-dtd'); });
  parser.on('opentag', tag => {
    depth++;
    if (WORD.has(tag.uri) && tag.local === 'comment' && !commentDepth) { commentDepth = depth; lastParaIds.push(undefined); }
    else if (commentDepth && WORD.has(tag.uri) && tag.local === 'p') lastParaIds[lastParaIds.length - 1] = Object.values(tag.attributes).find(item => item.uri === W14 && item.local === 'paraId')?.value;
  });
  parser.on('closetag', () => { if (depth === commentDepth) commentDepth = 0; depth--; });
  return { parser, lastParaIds };
}
/** Thread state per last-paragraph identity from commentsExtended (w15:commentEx). */
export function docxCommentThreads() {
  const parser = new SaxesParser({ xmlns: true }); const threads = new Map<string, { parent?: string; done?: string }>(); let root = false;
  parser.on('doctype', () => { throw Error('unsupported-xml-dtd'); });
  parser.on('opentag', tag => {
    if (!root) { root = true; if (tag.uri !== W15 || tag.local !== 'commentsEx') throw Error('unsupported-comments-extended'); return; }
    if (tag.uri !== W15 || tag.local !== 'commentEx') return;
    const value = (local: string) => Object.values(tag.attributes).find(item => item.uri === W15 && item.local === local)?.value;
    const id = value('paraId'); if (id && !threads.has(id)) threads.set(id, { parent: value('paraIdParent'), done: value('done') });
  });
  return { parser, threads };
}
/** Unresolved comments: a thread is resolved when its root comment's commentEx is done. Undefined without thread metadata. */
export function docxUnresolvedComments(lastParaIds: Array<string | undefined>, threads: Map<string, { parent?: string; done?: string }> | undefined): number | undefined {
  if (!threads) return undefined;
  return lastParaIds.filter(id => {
    const seen = new Set<string>(); let at = id;
    while (at && threads.get(at)?.parent && !seen.has(at)) { seen.add(at); at = threads.get(at)!.parent; }
    const done = at ? threads.get(at)?.done : undefined; return done !== '1' && done !== 'true';
  }).length;
}

/**
 * The current (all revisions accepted) view for the legacy plain-text extraction: the rejected side of tracked changes is
 * removed, a removed paragraph mark joins its paragraph to the next one and a deleted table row is omitted. Everything else
 * keeps the legacy extraction byte-for-byte. Streaming, so large bodies stay within the worker's bounded heap.
 */
export function docxAcceptedText(xml: string, progress = () => {}): { xml: string; revisions: boolean; comments: boolean } {
  if (!/<(?:[^\s<>/]+:)?(?:ins|del|moveFrom|moveTo|rPrChange|pPrChange|delText|delInstrText|commentRangeStart|commentRangeEnd|commentReference)(?=[\s/>])/.test(xml))
    return { xml, revisions: false, comments: false };
  const parser = new SaxesParser({ xmlns: true }); const chunks: string[] = [];
  let depth = 0; let hiddenDepth = 0; let start = 0; let hiddenStart = 0; let kept = 0; let changed = false;
  let hasRevisions = false; let comments = false;
  const path: Array<{ local?: string; start: number; markRemoved?: boolean }> = [];
  let merge: { closeStart: number; closeEnd: number } | undefined;
  parser.on('opentagstart', () => { start = xml.lastIndexOf('<', parser.position - 1); });
  parser.on('opentag', tag => {
    depth++; const local = WORD.has(tag.uri) ? tag.local : undefined; path.push({ local, start });
    if (local === 'p' && merge && !hiddenDepth && kept <= merge.closeStart) {
      // Drop the earlier paragraph's end and this paragraph's start; a self-closing paragraph keeps the earlier end.
      chunks.push(xml.slice(kept, merge.closeStart), xml.slice(merge.closeEnd, start), tag.isSelfClosing ? xml.slice(merge.closeStart, merge.closeEnd) : '');
      kept = parser.position; changed = true; merge = undefined;
    } else if (merge && !(local && betweenParagraphs.has(local))) merge = undefined;
    if (local) {
      if (revisions.has(local) || hidden.has(local)) hasRevisions = true;
      if (['commentRangeStart', 'commentRangeEnd', 'commentReference'].includes(local)) comments = true;
      const parent = path.at(-2); const grandparent = path.at(-3); const owner = path.at(-4);
      if ((local === 'del' || local === 'moveFrom') && parent?.local === 'trPr' && grandparent?.local === 'tr' && !hiddenDepth && kept <= grandparent.start) {
        hiddenDepth = depth - 2; hiddenStart = grandparent.start;
      }
      if ((local === 'del' || local === 'moveFrom') && parent?.local === 'rPr' && grandparent?.local === 'pPr' && owner?.local === 'p') owner.markRemoved = true;
      if (!hiddenDepth && hidden.has(local)) { hiddenDepth = depth; hiddenStart = start; }
    }
  });
  parser.on('closetag', () => {
    const entry = path.pop()!;
    if (hiddenDepth === depth) { chunks.push(xml.slice(kept, hiddenStart)); kept = parser.position; hiddenDepth = 0; changed = true; }
    else if (entry.local === 'p' && entry.markRemoved && !hiddenDepth) merge = { closeStart: xml.lastIndexOf('</', parser.position - 1), closeEnd: parser.position };
    depth--;
  });
  scan(parser, xml, progress);
  if (changed) chunks.push(xml.slice(kept));
  return { xml: changed ? chunks.join('') : xml, revisions: hasRevisions, comments };
}
