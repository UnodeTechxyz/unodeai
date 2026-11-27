// Word annotation IDs (w:id): allocation above every decimal value already used, and per-kind checks of the output.
import { SaxesParser } from 'saxes';
import { OFFICE_NS } from '../OfficePackage';
import { OfficeEditFailure } from '../OfficeEditContracts';

const WORD_ID_MAX = 2147483647n;
const revisionDefinitions = new Set(['ins', 'del', 'moveFrom', 'moveTo', 'rPrChange', 'pPrChange', 'sectPrChange', 'tblPrChange', 'tblPrExChange', 'trPrChange', 'tcPrChange',
  'tblGridChange', 'numberingChange', 'cellIns', 'cellDel', 'cellMerge', 'moveFromRangeStart', 'moveToRangeStart',
  'customXmlInsRangeStart', 'customXmlDelRangeStart', 'customXmlMoveFromRangeStart', 'customXmlMoveToRangeStart']);
const pairs: Record<string, [string, 'start' | 'end']> = {
  bookmarkStart: ['bookmark', 'start'], bookmarkEnd: ['bookmark', 'end'], commentRangeStart: ['comment', 'start'], commentRangeEnd: ['comment', 'end'],
  moveFromRangeStart: ['moveFrom', 'start'], moveFromRangeEnd: ['moveFrom', 'end'], moveToRangeStart: ['moveTo', 'start'], moveToRangeEnd: ['moveTo', 'end'],
};
export interface WordAnnotationFacts { max: bigint; revisions: string[]; comments: string[]; pairs: Map<string, Map<string, number>>; references: string[] }

/** One streaming pass over a story or comments part; only w:id values in the WordprocessingML namespace count. */
export function wordAnnotationFacts(xml: string, progress: () => void = () => {}): WordAnnotationFacts {
  const facts: WordAnnotationFacts = { max: -1n, revisions: [], comments: [], pairs: new Map(), references: [] };
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => { throw new OfficeEditFailure('unsupported-xml-dtd'); });
  parser.on('opentag', tag => {
    if (!OFFICE_NS.w.includes(tag.uri)) return;
    const id = Object.values(tag.attributes).find(attribute => attribute.local === 'id' && OFFICE_NS.w.includes(attribute.uri))?.value;
    if (id === undefined) return;
    if (/^\d{1,19}$/.test(id)) { const value = BigInt(id); if (value > facts.max) facts.max = value; }
    if (revisionDefinitions.has(tag.local)) facts.revisions.push(id);
    if (tag.local === 'comment') facts.comments.push(id);
    if (tag.local === 'commentReference') facts.references.push(id);
    const pair = pairs[tag.local];
    if (pair) {
      const counts = facts.pairs.get(pair[0]) ?? new Map<string, number>(); facts.pairs.set(pair[0], counts);
      counts.set(id, (counts.get(id) ?? 0) + (pair[1] === 'start' ? 1 : -1));
    }
  });
  for (let at = 0; at < xml.length; at += 65536) { progress(); parser.write(xml.slice(at, at + 65536)); }
  parser.close(); return facts;
}

export class WordIdAllocator {
  readonly own = new Set<string>();
  private next: bigint;
  /** New IDs exceed the largest decimal w:id in every story and comments part, so they cannot collide with any existing value. */
  constructor(facts: WordAnnotationFacts[]) { this.next = facts.reduce((max, item) => item.max > max ? item.max : max, -1n) + 1n; }
  allocate(): string {
    if (this.next > WORD_ID_MAX) throw new OfficeEditFailure('word-id-space-exhausted');
    const id = String(this.next); this.next++; this.own.add(id); return id;
  }
}

const duplicates = (values: string[]) => { const seen = new Set<string>(); const repeated = new Set<string>(); for (const value of values) (seen.has(value) ? repeated : seen).add(value); return repeated; };
function merge(facts: WordAnnotationFacts[]) {
  const pairsByKind = new Map<string, Map<string, number>>();
  for (const item of facts) for (const [kind, counts] of item.pairs) {
    const merged = pairsByKind.get(kind) ?? new Map<string, number>(); pairsByKind.set(kind, merged);
    for (const [id, count] of counts) merged.set(id, (merged.get(id) ?? 0) + count);
  }
  const unbalanced = new Map([...pairsByKind].map(([kind, counts]) => [kind, new Set([...counts].filter(([, count]) => count !== 0).map(([id]) => id))]));
  const comments = new Set(facts.flatMap(item => item.comments));
  return { revisions: facts.flatMap(item => item.revisions), comments: facts.flatMap(item => item.comments), unbalanced,
    dangling: new Set(facts.flatMap(item => item.references).filter(id => !comments.has(id))) };
}
/**
 * Kind- and scope-aware check (definitions, pairs, references): the output may keep a problem the input already had, never add one.
 * Each ID this request allocated is defined at most once and was not in the input.
 */
export function checkWordAnnotations(input: WordAnnotationFacts[], output: WordAnnotationFacts[], own: ReadonlySet<string>): boolean {
  const before = merge(input); const after = merge(output);
  const subset = (left: Set<string>, right: Set<string>) => [...left].every(value => right.has(value));
  if (!subset(duplicates(after.revisions), duplicates(before.revisions)) || !subset(duplicates(after.comments), duplicates(before.comments))) return false;
  for (const [kind, ids] of after.unbalanced) if (!subset(ids, before.unbalanced.get(kind) ?? new Set())) return false;
  if (!subset(after.dangling, before.dangling)) return false;
  const used = new Set([...before.revisions, ...before.comments]);
  for (const id of own) {
    if (used.has(id) || after.revisions.filter(value => value === id).length + after.comments.filter(value => value === id).length > 1) return false;
  }
  return true;
}
