// One edit_office request on a Word package: ID allocation before the first change, and the read-back checks of design
// 13.1/13.2 after the last one. Pure JavaScript.
import type { OfficePackage } from '../OfficePackage';
import { decodeOfficeXml } from '../OfficeTextPatch';
import { OfficeEditFailure } from '../OfficeEditContracts';
import { checkWordAnnotations, wordAnnotationFacts, WordIdAllocator, type WordAnnotationFacts } from './WordIdAllocator';
import { wordStoryModelFromXml, type WordRevisionItem, type WordStoryModel } from './WordRevisionModel';
import type { WordTrackingSession } from './WordTrackedEdits';
import { decideWordRevision } from './WordTrackedEdits';
import { officeWordStory } from '../OfficeWordStory';

const PREFIX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.';
/** Story and comments parts by content type (compared case-insensitively). */
const storyTypes: Record<string, 'header' | 'footer' | 'other'> = {
  [PREFIX + 'header+xml']: 'header', [PREFIX + 'footer+xml']: 'footer', [PREFIX + 'footnotes+xml']: 'other', [PREFIX + 'endnotes+xml']: 'other', [PREFIX + 'comments+xml']: 'other',
};
const fail = (): never => { throw new OfficeEditFailure('office-output-check-failed'); };
const xmlOf = (bytes: Buffer) => decodeOfficeXml(bytes).xml;

export class WordEditSession {
  readonly ids: WordIdAllocator;
  private readonly facts = new Map<string, WordAnnotationFacts>();
  private readonly kinds = new Map<string, 'main' | 'header' | 'footer' | 'other'>();
  private readonly decisions = new Map<string, Array<Parameters<typeof decideWordRevision>[1] & { decision: 'accept' | 'reject' }>>();
  private constructor(facts: Map<string, WordAnnotationFacts>, kinds: Map<string, 'main' | 'header' | 'footer' | 'other'>, private readonly inputs: Map<string, Buffer>) {
    this.facts = facts; this.kinds = kinds; this.ids = new WordIdAllocator([...facts.values()]);
  }
  /** Scans every story and comments part for annotation IDs before anything is written. */
  static async open(pkg: OfficePackage, readPart: (name: string) => Promise<Buffer>, progress: () => void) {
    const facts = new Map<string, WordAnnotationFacts>(); const kinds = new Map<string, 'main' | 'header' | 'footer' | 'other'>(); const inputs = new Map<string, Buffer>();
    for (const part of pkg.parts) {
      const kind = storyTypes[(part.contentType ?? '').toLowerCase()];
      if (!kind && part.name !== pkg.main.name) continue;
      const bytes = await readPart(part.name); inputs.set(part.name, bytes); kinds.set(part.name, part.name === pkg.main.name ? 'main' : kind ?? 'other');
      // A part that does not parse is never edited here; its IDs still bound new ones through a plain scan of every id value.
      try { facts.set(part.name, wordAnnotationFacts(xmlOf(bytes), progress)); }
      catch { facts.set(part.name, { max: [...plainText(bytes).matchAll(/:id\s*=\s*["'](\d{1,19})["']/g)].reduce((max, match) => BigInt(match[1]) > max ? BigInt(match[1]) : max, -1n), revisions: [], comments: [], pairs: new Map(), references: [] }); }
    }
    return new WordEditSession(facts, kinds, inputs);
  }
  noteDecision(part: string, identity: Parameters<typeof decideWordRevision>[1], decision: 'accept' | 'reject') {
    const list = this.decisions.get(part) ?? []; list.push({ ...identity, decision }); this.decisions.set(part, list);
  }
  storyKind(part: string) { return this.kinds.get(part); }

  /**
   * Read-back after all edits. IDs: kind-aware definitions, pairs and references, and each new ID defined once.
   * Rollback projection (tracked requests): rejecting only this request's revisions gives the input's current and original
   * text and its other revisions (after this request's accept/reject decisions, applied to the input alone). A direct request
   * changes text by design; there each decided revision must be absent from the output. New revisions carry the
   * request's author and date. Returns the new revisions as they appear in the output.
   */
  verify(output: (name: string) => Buffer | undefined, session: WordTrackingSession | undefined, progress: () => void, createdParts: string[] = []) {
    const outputs = new Map([...this.facts.keys()].map(name => [name, output(name) ?? this.inputs.get(name)!]));
    // Parts this request created (comment parts) take part in the ID checks of the output only.
    const created = createdParts.filter(name => !this.facts.has(name) && output(name)).map(name => wordAnnotationFacts(xmlOf(output(name)!), progress));
    if (!checkWordAnnotations([...this.facts.values()], [...[...outputs].map(([name, bytes]) => output(name) ? wordAnnotationFacts(xmlOf(bytes), progress) : this.facts.get(name)!), ...created], this.ids.own)) fail();
    const own = this.ids.own; const added: Array<{ part: string; story: 'main' | 'header' | 'footer'; ordinal: number; kind: string; author: string }> = [];
    for (const [name, bytes] of outputs) {
      const kind = this.kinds.get(name); if (kind !== 'main' && kind !== 'header' && kind !== 'footer' || !output(name)) continue;
      const after = wordStoryModelFromXml(xmlOf(bytes), kind, progress, true, true);
      if (session) {
        // Tracked request: every text change is a revision of this request, so rejecting them gives the input after the decisions.
        let baseline = this.inputs.get(name)!;
        for (const decision of this.decisions.get(name) ?? []) baseline = wrapStory(baseline, kind, story => decideWordRevision(story, decision, decision.decision, progress).bytes);
        const before = wordStoryModelFromXml(xmlOf(baseline), kind, progress, true, true);
        for (const view of ['current', 'original'] as const) {
          if (JSON.stringify(projectedText(after, view, own, 'reject')) !== JSON.stringify(projectedText(before, view, new Set(), 'reject'))) fail();
        }
        const foreign = (model: WordStoryModel) => model.items.filter(item => !own.has(item.wordId ?? '')).map(item => JSON.stringify([item.kind, item.scope, item.author, item.date, item.wordId ?? null, item.scope === 'inline' ? item.text : ''])).sort();
        if (JSON.stringify(foreign(after)) !== JSON.stringify(foreign(before))) fail();
      } else {
        // Direct request: its text edits are checked by each editor; every decided revision must be gone from the output.
        for (const decision of this.decisions.get(name) ?? []) {
          if (after.groups.some(group => group.kind === decision.kind && (group.author || null) === decision.author
            && JSON.stringify(group.items.map(item => item.wordId ?? null)) === JSON.stringify(decision.wordIds))) fail();
        }
      }
      for (const group of after.groups) {
        const mine = group.items.filter(item => own.has(item.wordId ?? ''));
        if (!mine.length) continue;
        if (mine.length !== group.items.length && !group.items.every(item => item.kind === 'format-run')) fail();
        // A run split copies its property history with a new ID but the original author and date (design 13.1).
        if (session && mine.some(item => item.scope !== 'property' && (item.author !== session.author || item.date !== session.date))) fail();
        if (group.kind === 'insert' || group.kind === 'delete') added.push({ part: name, story: kind, ordinal: group.ordinal, kind: group.kind, author: group.author });
      }
    }
    return added;
  }
}

/** Header and footer decisions run on the same story adapter the editors use; the main story is used as is. */
function wrapStory(bytes: Buffer, kind: 'main' | 'header' | 'footer', work: (story: Buffer) => Buffer): Buffer {
  if (kind === 'main') return work(bytes);
  const adapter = officeWordStory(bytes, kind, () => {}); return adapter.finish(work(adapter.bytes));
}

/** Story text in one view when this request's revisions are rejected (or accepted) and every other revision follows the view. */
export function projectedText(model: WordStoryModel, view: 'current' | 'original', own: ReadonlySet<string>, decision: 'accept' | 'reject'): string[] {
  const removing = (item: WordRevisionItem) => {
    const inserted = item.kind === 'insert' || item.kind === 'move-to'; const deleted = item.kind === 'delete' || item.kind === 'move-from';
    if (own.has(item.wordId ?? '')) return decision === 'reject' ? inserted : deleted;
    return view === 'current' ? deleted : inserted;
  };
  const output: string[] = []; let carry: string | undefined;
  for (const paragraph of model.paragraphs) {
    if (paragraph.row?.item && removing(paragraph.row.item)) continue;
    let text = carry ?? '';
    for (const piece of paragraph.pieces ?? []) {
      if (piece.stack.some(removing)) continue;
      if (piece.delText && !piece.stack.some(item => item.kind === 'delete' || item.kind === 'move-from') && view === 'current') continue;
      text += piece.text;
    }
    if (paragraph.mark && removing(paragraph.mark)) { carry = text; continue; }
    carry = undefined; output.push(text);
  }
  if (carry !== undefined) output.push(carry);
  return output;
}
function plainText(bytes: Buffer) { try { return xmlOf(bytes); } catch { return bytes.toString('latin1'); } }
