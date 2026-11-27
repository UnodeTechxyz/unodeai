// Word comments written by edit_office: add a comment on literal text, reply in a thread, resolve a thread (design 4.4 / 13.4).
// Comments are not revisions; the parts and links follow a Word 16 saved file (see the word-revisions test fixture).
import { randomInt } from 'node:crypto';
import { officeXmlElements, type OfficeXmlDocument, type OfficeXmlElement } from '../OfficeXmlElements';
import { encodeOfficeXml, decodeOfficeXml } from '../OfficeTextPatch';
import { mutateOfficeXml, officeXmlAttribute, officeXmlOpening } from '../OfficeXmlMutations';
import { OfficeEditFailure, type OfficeEditCode } from '../OfficeEditContracts';
import { isWordElement as w, attributeIn, wordAttribute, wordDescendants } from './WordXml';
import { W14, W15, W16CEX, W16CID, wordComments, type WordComment, type WordCommentPartKey } from './WordComments';
import { escapeWordText, wordBodyParagraphs, wordCurrentPieces, wordNames } from './WordTrackedEdits';

const fail = (code: OfficeEditCode): never => { throw new OfficeEditFailure(code); };
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const roots: Record<Exclude<WordCommentPartKey, 'extensible'>, string> = {
  comments: `<w:comments xmlns:w="${W}" xmlns:w14="${W14}" xmlns:mc="${MC}" mc:Ignorable="w14"/>`,
  extended: `<w15:commentsEx xmlns:w15="${W15}" xmlns:mc="${MC}" mc:Ignorable="w15"/>`,
  ids: `<w16cid:commentsIds xmlns:w16cid="${W16CID}" xmlns:mc="${MC}" mc:Ignorable="w16cid"/>`,
  people: `<w15:people xmlns:w15="${W15}" xmlns:mc="${MC}" mc:Ignorable="w15"/>`,
};
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export interface WordCommentAuthor { author: string; initials: string; date: string }
/** Package access for one request: current part bytes, part names of the comment parts, and creation of a missing part. */
export interface WordCommentPackage {
  read(name: string): Promise<Buffer>; write(name: string, bytes: Buffer): void;
  parts: Partial<Record<WordCommentPartKey, string>>; create(key: Exclude<WordCommentPartKey, 'extensible'>, bytes: Buffer): Promise<string>;
  storyParts: string[]; allocateId(): string;
}
const hex = (value: number, digits: number) => value.toString(16).toUpperCase().padStart(digits, '0');

export class WordCommentEditor {
  private readonly paraIds = new Set<string>(); private readonly durableIds = new Set<string>(); private scanned = false;
  constructor(private readonly pkg: WordCommentPackage, private readonly who: WordCommentAuthor, private readonly progress: () => void) {}
  private async scan() {
    if (this.scanned) return; this.scanned = true;
    for (const name of [...this.pkg.storyParts, ...Object.values(this.pkg.parts)]) {
      if (!name) continue; let text: string; try { text = decodeOfficeXml(await this.pkg.read(name)).xml; } catch { continue; }
      for (const match of text.matchAll(/:(paraId|paraIdParent|durableId)\s*=\s*["']([0-9A-Fa-f]{1,8})["']/g)) (match[1] === 'durableId' ? this.durableIds : this.paraIds).add(match[2].toUpperCase());
    }
  }
  /** w14:paraId: 31-bit, below 0x80000000; w16cid:durableId: 32-bit; both unique in the package, by random value and retry. */
  private paraId() { let value: string; do { value = hex(randomInt(1, 0x7fffffff), 8); } while (this.paraIds.has(value)); this.paraIds.add(value); return value; }
  private durableId() { let value: string; do { value = hex(randomInt(1, 0xffffffff), 8); } while (this.durableIds.has(value)); this.durableIds.add(value); return value; }
  private async part(key: Exclude<WordCommentPartKey, 'extensible'>) {
    if (!this.pkg.parts[key]) this.pkg.parts[key] = await this.pkg.create(key, Buffer.from(declaration + roots[key]));
    return this.pkg.parts[key]!;
  }
  private async append(key: WordCommentPartKey, xml: string) {
    const name = key === 'extensible' ? this.pkg.parts.extensible : await this.part(key); if (!name) return;
    const definition = { comments: [W, 'comments'], extended: [W15, 'commentsEx'], ids: [W16CID, 'commentsIds'], extensible: [W16CEX, 'commentsExtensible'], people: [W15, 'people'] }[key];
    this.pkg.write(name, mutateOfficeXml(await this.pkg.read(name), () => undefined, this.progress, { namespace: definition[0], local: definition[1], xml }));
  }
  private async set() { return wordComments({ comments: this.pkg.parts.comments ? await this.pkg.read(this.pkg.parts.comments) : undefined,
    extended: this.pkg.parts.extended ? await this.pkg.read(this.pkg.parts.extended) : undefined }, this.progress); }

  /** New comment element, its thread metadata, its durable ID and its author entry. Returns the comment's last paragraph identity. */
  private async newComment(id: string, text: string, parentParaId: string | undefined, metadata: boolean) {
    const paragraphs = text.replace(/\r\n?/g, '\n').split('\n').map(() => this.paraId());
    const body = text.replace(/\r\n?/g, '\n').split('\n').map((line, index) => `<w:p w14:paraId="${paragraphs[index]}" w14:textId="77777777">${index ? '' : '<w:r><w:annotationRef/></w:r>'}${line ? `<w:r>${line.split('\t').map(part => `<w:t xml:space="preserve">${escapeWordText(part)}</w:t>`).join('<w:tab/>')}</w:r>` : ''}</w:p>`).join('');
    await this.append('comments', `<w:comment xmlns:w="${W}" xmlns:w14="${W14}" w:id="${id}" w:author="${officeXmlAttribute(this.who.author)}" w:date="${this.who.date}" w:initials="${officeXmlAttribute(this.who.initials)}">${body}</w:comment>`);
    const last = paragraphs.at(-1)!;
    if (metadata) {
      await this.append('extended', `<w15:commentEx xmlns:w15="${W15}" w15:paraId="${last}"${parentParaId ? ` w15:paraIdParent="${parentParaId}"` : ''} w15:done="0"/>`);
      const durable = this.durableId();
      await this.append('ids', `<w16cid:commentId xmlns:w16cid="${W16CID}" w16cid:paraId="${last}" w16cid:durableId="${durable}"/>`);
      await this.append('extensible', `<w16cex:commentExtensible xmlns:w16cex="${W16CEX}" w16cex:durableId="${durable}" w16cex:dateUtc="${this.who.date}"/>`);
    }
    const people = this.pkg.parts.people ? decodeOfficeXml(await this.pkg.read(this.pkg.parts.people)).xml : '';
    const known = [...people.matchAll(/:author\s*=\s*"([^"]*)"/g)].some(match => match[1] === officeXmlAttribute(this.who.author));
    if (!known) await this.append('people', `<w15:person xmlns:w15="${W15}" w15:author="${officeXmlAttribute(this.who.author)}"/>`);
    return last;
  }

  /** Anchors a new comment on the one literal occurrence of `find` in the paragraph; runs are split at text offsets only. */
  async add(story: Buffer, ordinal: number, find: string, text: string) {
    await this.scan(); if (!find) return fail('empty-text-match');
    const parsed = officeXmlElements(story, this.progress); const xml = parsed.decoded.xml; const paragraph = wordBodyParagraphs(parsed)[ordinal - 1];
    if (!paragraph) return fail('unsupported-edit-target');
    const pieces = wordCurrentPieces([paragraph], xml); let at = 0; const placed = pieces.map(piece => { const start = at; at += piece.text.length; return { ...piece, start, end: at }; });
    const whole = pieces.map(piece => piece.text).join(''); const start = whole.indexOf(find);
    if (start < 0) return fail('text-not-found'); if (whole.indexOf(find, start + 1) >= 0) return fail('comment-anchor-ambiguous');
    const end = start + find.length;
    const touched = placed.filter(piece => piece.start < end && piece.end > start || piece.boundary && piece.start > start && piece.start < end);
    if (touched.some(piece => piece.boundary || !piece.node)) return fail('text-match-crosses-structural-control');
    const id = this.pkg.allocateId(); const name = wordNames(paragraph);
    const startMarker = `<${name.element('commentRangeStart')}${name.declare} ${name.attribute('id')}="${id}"/>`;
    const endMarker = `<${name.element('commentRangeEnd')}${name.declare} ${name.attribute('id')}="${id}"/><${name.element('r')}${name.declare}><${name.element('rPr')}${name.declare}><${name.element('rStyle')}${name.declare} ${name.attribute('val')}="CommentReference"/></${name.element('rPr')}><${name.element('commentReference')}${name.declare} ${name.attribute('id')}="${id}"/></${name.element('r')}>`;
    const first = touched[0]; const last = touched.at(-1)!;
    const patches = splitAround(xml, first.run!, last.run!, new Map(touched.map(piece => [piece.node!, { from: Math.max(0, start - piece.start), to: Math.min(piece.text.length, end - piece.start) }])), startMarker, endMarker, this.pkg.allocateId);
    const output = applyPatches(parsed, patches);
    await this.newComment(id, text, undefined, true);
    return { bytes: output, id };
  }

  /** A reply shares its parent's position: its range markers beside the parent's, its reference after the parent's reference run. */
  async reply(stories: Array<{ name: string; bytes: Buffer }>, parentId: string, text: string) {
    await this.scan(); const set = await this.set(); const parent = set.comments.find(comment => comment.id === parentId); if (!parent) return fail('edit-target-unavailable');
    const legacy = !this.pkg.parts.extended;
    const parentPara = await this.ensureParaId(parent);
    for (const story of stories) {
      const parsed = officeXmlElements(story.bytes, this.progress);
      const marks = (local: string) => parsed.elements.filter(element => w(element, local) && wordAttribute(element, 'id') === parentId);
      const reference = marks('commentReference')[0]; if (!reference) continue;
      const startMark = marks('commentRangeStart')[0]; const endMark = marks('commentRangeEnd')[0];
      const run = w(reference.parent, 'r') ? reference.parent! : reference; const id = this.pkg.allocateId(); const name = wordNames(run);
      const patches: Patch[] = [];
      if (startMark && endMark) patches.push({ start: startMark.end, end: startMark.end, text: `<${name.element('commentRangeStart')}${name.declare} ${name.attribute('id')}="${id}"/>` });
      patches.push({ start: run.end, end: run.end, text: `${startMark && endMark ? `<${name.element('commentRangeEnd')}${name.declare} ${name.attribute('id')}="${id}"/>` : ''}<${name.element('r')}${name.declare}><${name.element('rPr')}${name.declare}><${name.element('rStyle')}${name.declare} ${name.attribute('val')}="CommentReference"/></${name.element('rPr')}><${name.element('commentReference')}${name.declare} ${name.attribute('id')}="${id}"/></${name.element('r')}>` });
      const output = applyPatches(parsed, patches);
      if (legacy) await this.append('extended', `<w15:commentEx xmlns:w15="${W15}" w15:paraId="${parentPara}" w15:done="0"/>`);
      else if (!parent.extended) await this.append('extended', `<w15:commentEx xmlns:w15="${W15}" w15:paraId="${parentPara}" w15:done="0"/>`);
      await this.newComment(id, text, parentPara, true);
      return { name: story.name, bytes: output, id };
    }
    return fail('edit-target-unavailable');
  }

  /** Resolves the thread: done="1" on the root comment and, as Word writes it, on every comment of the thread. */
  async resolve(commentId: string) {
    await this.scan(); const set = await this.set(); const comment = set.comments.find(item => item.id === commentId); if (!comment) return fail('edit-target-unavailable');
    const root = set.root(comment); const thread = set.comments.filter(item => set.root(item) === root);
    for (const member of thread) if (!member.extended) await this.append('extended', `<w15:commentEx xmlns:w15="${W15}" w15:paraId="${await this.ensureParaId(member)}" w15:done="1"/>`);
    const done = new Set(await Promise.all(thread.filter(member => member.extended).map(member => member.lastParaId!)));
    const name = this.pkg.parts.extended!;
    this.pkg.write(name, mutateOfficeXml(await this.pkg.read(name), tag => tag.uri === W15 && tag.local === 'commentEx' && done.has(Object.values(tag.attributes).find(item => item.uri === W15 && item.local === 'paraId')?.value ?? '')
      && Object.values(tag.attributes).some(item => item.uri === W15 && item.local === 'done') ? { name: Object.values(tag.attributes).find(item => item.uri === W15 && item.local === 'done')!.name, value: '1' } : undefined, this.progress));
    const withoutDone = thread.filter(member => member.extended && member.extended.done === undefined).map(member => member.lastParaId!);
    if (withoutDone.length) {
      const parsed = officeXmlElements(await this.pkg.read(name), this.progress); const patches: Patch[] = [];
      for (const element of parsed.elements) if (element.tag.uri === W15 && element.tag.local === 'commentEx' && withoutDone.includes(attributeIn(element, W15, 'paraId') ?? '')) {
        const prefix = element.tag.prefix ? element.tag.prefix + ':' : 'w15:'; const declare = element.tag.prefix ? '' : ` xmlns:w15="${W15}"`;
        patches.push({ start: element.start, end: element.openEnd, text: officeXmlOpening(parsed.decoded.xml.slice(element.start, element.openEnd), prefix + 'done', '1').replace(/\s+(\/?>)$/, `${declare}$1`) });
      }
      this.pkg.write(name, applyPatches(parsed, patches));
    }
    return { root: root.id };
  }

  /** The comment's last paragraph identity, adding a w14:paraId (and the w14 declaration on the comments root) when it has none. */
  private async ensureParaId(comment: WordComment): Promise<string> {
    if (comment.lastParaId) return comment.lastParaId.toUpperCase();
    const name = this.pkg.parts.comments!; const parsed = officeXmlElements(await this.pkg.read(name), this.progress); const xml = parsed.decoded.xml;
    const element = parsed.elements.find(item => w(item, 'comment') && wordAttribute(item, 'id') === comment.id); const last = element ? [...wordDescendants(element)].filter(item => w(item, 'p')).at(-1) : undefined;
    if (!last) return fail('unsupported-edit-target');
    const value = this.paraId(); const root = parsed.elements[0]; const patches: Patch[] = [];
    let opening = xml.slice(root.start, root.openEnd);
    const prefixOf = (uri: string) => Object.values(root.tag.attributes).find(item => item.uri === 'http://www.w3.org/2000/xmlns/' && item.value === uri)?.local;
    let w14 = prefixOf(W14);
    if (!w14) { w14 = 'w14'; opening = officeXmlOpening(opening, 'xmlns:w14', W14); }
    let mc = prefixOf(MC); if (!mc) { mc = 'mc'; opening = officeXmlOpening(opening, 'xmlns:mc', MC); }
    const ignorable = Object.values(root.tag.attributes).find(item => item.uri === MC && item.local === 'Ignorable');
    if (!ignorable?.value.split(/\s+/).includes(w14)) opening = officeXmlOpening(opening, `${mc}:Ignorable`, [ignorable?.value, w14].filter(Boolean).join(' '));
    patches.push({ start: root.start, end: root.openEnd, text: opening });
    patches.push({ start: last.start, end: last.openEnd, text: officeXmlOpening(xml.slice(last.start, last.openEnd), `${w14}:paraId`, value) });
    this.pkg.write(name, applyPatches(parsed, patches)); comment.lastParaId = value; return value;
  }
}

type Patch = { start: number; end: number; text: string };
function applyPatches(parsed: OfficeXmlDocument, patches: Patch[]) {
  const xml = parsed.decoded.xml; const chunks: string[] = []; let cursor = 0;
  for (const patch of [...patches].sort((left, right) => left.start - right.start || left.end - right.end)) {
    if (patch.start < cursor) return fail('unsupported-package-preservation'); chunks.push(xml.slice(cursor, patch.start), patch.text); cursor = patch.end;
  }
  chunks.push(xml.slice(cursor)); return encodeOfficeXml({ ...parsed.decoded, xml: chunks.join('') });
}

/**
 * Splits the first and last anchored runs at the anchor's text offsets (both halves keep the run properties; a copied rPrChange
 * gets a new ID) and places the markers immediately before the first anchored text and after the last.
 */
function splitAround(xml: string, firstRun: OfficeXmlElement, lastRun: OfficeXmlElement, covered: Map<OfficeXmlElement, { from: number; to: number }>, before: string, after: string, allocateId: () => string): Patch[] {
  const runs = firstRun === lastRun ? [firstRun] : [firstRun, lastRun];
  return runs.map(run => {
    const properties = run.children.find(child => w(child, 'rPr')); const change = properties?.children.find(child => w(child, 'rPrChange')); let copies = 0;
    const rPr = () => {
      if (!properties) return ''; if (copies++ === 0 || !change) return xml.slice(properties.start, properties.end);
      const opening = officeXmlOpening(xml.slice(change.start, change.openEnd), change.tag.prefix ? `${change.tag.prefix}:id` : 'id', allocateId());
      return xml.slice(properties.start, change.start) + opening + xml.slice(change.openEnd, properties.end);
    };
    const opening = xml.slice(run.start, run.openEnd); const parts: Array<{ xml: string; inside: boolean }> = [];
    const children = run.children.filter(child => child !== properties);
    const marked = children.map(child => covered.has(child)); const firstCovered = marked.indexOf(true); const lastCovered = marked.lastIndexOf(true);
    // The anchor continues past the first run's end and starts before the last run's beginning.
    const low = run === firstRun ? firstCovered : 0; const high = run === lastRun ? lastCovered : children.length - 1;
    children.forEach((child, index) => {
      const span = covered.get(child);
      if (span && w(child, 't')) {
        const value = decodeText(xml, child); const element = (part: string) => `${officeXmlOpening(xml.slice(child.start, child.openEnd), 'xml:space', 'preserve')}${escapeWordText(part)}</${child.tag.name}>`;
        if (span.from > 0) parts.push({ xml: element(value.slice(0, span.from)), inside: false });
        parts.push({ xml: element(value.slice(span.from, span.to)), inside: true });
        if (span.to < value.length) parts.push({ xml: element(value.slice(span.to)), inside: false });
      } else parts.push({ xml: xml.slice(child.start, child.end), inside: index >= low && index <= high });
    });
    // Group into before / anchored / after runs; markers go at the anchored run boundaries.
    let output = ''; let index = 0; const firstInside = parts.findIndex(part => part.inside); const lastInside = parts.length - 1 - [...parts].reverse().findIndex(part => part.inside);
    while (index < parts.length) {
      const inside = parts[index].inside; let content = ''; const startIndex = index;
      while (index < parts.length && parts[index].inside === inside) content += parts[index++].xml;
      if (inside && run === firstRun && startIndex === firstInside) output += before;
      output += `${opening}${rPr()}${content}</${run.tag.name}>`;
      if (inside && run === lastRun && index - 1 === lastInside) output += after;
    }
    return { start: run.start, end: run.end, text: output };
  });
}
function decodeText(xml: string, element: OfficeXmlElement) {
  if (element.tag.isSelfClosing) return '';
  return xml.slice(element.openEnd, xml.lastIndexOf('</', element.end - 1)).replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_whole, entity: string) =>
    entity === 'lt' ? '<' : entity === 'gt' ? '>' : entity === 'amp' ? '&' : entity === 'quot' ? '"' : entity === 'apos' ? "'" : String.fromCodePoint(entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)));
}
