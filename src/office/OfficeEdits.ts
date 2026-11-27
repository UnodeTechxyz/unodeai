import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { OfficePackage, type OfficeKind } from './OfficePackage';
import { opcPartName } from '../content/OpcReadPackage';
import { xmlAttribute } from '../content/WorkbookXml';
import { WorkbookJsonIndex } from '../content/WorkbookJsonIndex';
import type { OfficeRecord } from './OfficeInventory';
import { decodeOfficeXml, encodeOfficeXml, replaceOfficeText, type OfficeTextTarget } from './OfficeTextPatch';
import { OfficeEditFailure, type OfficeEditCode, type OfficeEditInput, type OfficeEditResult } from './OfficeEditContracts';
import { PresentationSlideCopy } from './PresentationSlideCopy';
import { patchOfficePicture } from './OfficePicturePatch';
import { decodePng } from './PngDecode';
import { decodeJpeg } from './JpegDecode';
import { getHeapStatistics } from 'node:v8';
import { inheritedPictureGeometry } from './OfficePictureGeometry';
import type { PresentationImageReceipt } from './PresentationContracts';
import { readOfficeChart, patchOfficeChart, patchOfficeChartReference, setOfficeChartTitle } from './OfficeChartPatch';
import { officeChartData, type OfficeChartFact } from './OfficeChartData';
import { addOfficeChartSheet, emptyOfficeChartWorkbook } from './OfficeChartSheet';
import { officeSlideOwnedParts } from './OfficePartCloner';
import { setOfficeShapeText } from './OfficeShapeText';
import { setOfficeThemeTokens } from './OfficeThemeTokens';
import { insertOfficeWordParagraphs, OfficeWordParagraphOrder } from './OfficeWordParagraphs';
import { insertOfficeWordTable, OfficeWordTableOrder } from './OfficeWordTable';
import { setOfficeControlText } from './OfficeControlText';
import { setOfficeBookmarkText } from './OfficeBookmarkText';
import { patchWordPicture, wordPictureElements } from './OfficeWordPicture';
import { OfficeWordMedia } from './OfficeWordMedia';
import { officeWordStory } from './OfficeWordStory';
import { WordEditSession } from './word/WordEditSession';
import { WordCommentEditor } from './word/WordCommentEdits';
import { wordCommentPartNames } from './word/WordInventory';
import { WORD_COMMENT_PARTS, wordComments } from './word/WordComments';
import { decideWordRevision, trackedAssignRegion, trackedReplaceText, trackInsertedParagraphs, trackInsertedTable, type WordTrackingSession } from './word/WordTrackedEdits';
const fail = (code: OfficeEditCode): never => { throw new OfficeEditFailure(code); };
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function targets(input: OfficeEditInput, progress: () => void): Map<string, OfficeRecord> {
  const wanted = new Set(input.edits.map(edit => edit.target_ref)); const found = new Map<string, OfficeRecord>();
  const records = new WorkbookJsonIndex<OfficeRecord>(input.directory, 'inventory');
  try { if (records.count !== input.manifest.records) return fail('edit-target-unavailable');
    for (let index = 0; index < records.count && found.size < wanted.size; index++) { progress(); const record = records.get(index)!;
    if (wanted.has(record.id)) { if (!['object', 'paragraph', 'table-cell', 'slide', 'part', 'bookmark', 'content-control', 'revision', 'comment'].includes(record.kind)) return fail('unsupported-edit-target'); found.set(record.id, record); }
  } } finally { records.close(); }
  if (found.size !== wanted.size) return fail('edit-target-unavailable'); return found;
}
const escapeAttribute = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
function contentTypeOpening(opening: string, mime: string): string {
  let at = 1; while (at < opening.length && !/[ \t\r\n/>]/.test(opening[at])) at++;
  while (at < opening.length) {
    while (/[ \t\r\n]/.test(opening[at])) at++; if (opening[at] === '/' || opening[at] === '>') break;
    const start = at; while (at < opening.length && !/[ \t\r\n=]/.test(opening[at])) at++; const name = opening.slice(start, at);
    while (/[ \t\r\n]/.test(opening[at])) at++; if (opening[at++] !== '=') return fail('invalid-office-content-types'); while (/[ \t\r\n]/.test(opening[at])) at++;
    const quote = opening[at++]; if (quote !== '"' && quote !== "'") return fail('invalid-office-content-types'); const value = at;
    while (at < opening.length && opening[at] !== quote) at++;
    if (name === 'ContentType') return opening.slice(0, value) + escapeAttribute(mime) + opening.slice(at); at++;
  }
  return fail('invalid-office-content-types');
}
function convertTemplate(bytes: Buffer, main: string, kind: OfficeKind, progress: () => void): Buffer {
  const value = decodeOfficeXml(bytes); const parser = new SaxesParser({ xmlns: true }); let start = 0; let depth = 0; let patch: { start: number; end: number; text: string } | undefined; let close = -1;
  const mime = kind === 'pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
  parser.on('doctype', () => fail('unsupported-xml-dtd'));
  parser.on('opentagstart', () => { start = value.xml.lastIndexOf('<', parser.position - 1); });
  parser.on('opentag', tag => { depth++; if (depth === 2 && tag.uri === 'http://schemas.openxmlformats.org/package/2006/content-types' && tag.local === 'Override'
    && xmlAttribute(tag, 'PartName') && opcPartName(xmlAttribute(tag, 'PartName')!) === main) patch = { start, end: parser.position, text: contentTypeOpening(value.xml.slice(start, parser.position), mime) }; });
  parser.on('closetag', tag => { if (depth === 1 && tag.uri === 'http://schemas.openxmlformats.org/package/2006/content-types' && tag.local === 'Types') close = value.xml.lastIndexOf('</', parser.position - 1); depth--; });
  for (let at = 0; at < value.xml.length; at += 65536) { progress(); parser.write(value.xml.slice(at, at + 65536)); } parser.close();
  if (!patch) { if (close < 0) return fail('invalid-office-content-types'); patch = { start: close, end: close,
    text: `<Override xmlns="http://schemas.openxmlformats.org/package/2006/content-types" PartName="${escapeAttribute(main)}" ContentType="${mime}"/>` }; }
  return encodeOfficeXml({ ...value, xml: value.xml.slice(0, patch.start) + patch.text + value.xml.slice(patch.end) });
}

/** Fixed preserving writer. Every untouched uncompressed part is compared with actual output bytes. */
export async function editOfficePackage(input: OfficeEditInput, ratio: number, floor: number, progress: () => void): Promise<OfficeEditResult> {
  const source = await readFile(input.source); if (sha(source) !== input.manifest.sha256) return fail('source-changed');
  const pkg = await OfficePackage.open(input.source, ratio, floor, progress);
  try {
    if (pkg.kind !== input.manifest.kind) return fail('source-changed');
    if (pkg.macroEnabled || pkg.parts.some(part => /vbaProject/i.test(part.contentType ?? ''))) return fail('macro-edit-unavailable');
    const selected = targets(input, progress); const wanted = new Set([...selected.values()].map(record => input.manifest.parts.find(part => part.ref === record.record.part_ref)?.name));
    if (wanted.has(undefined)) return fail('edit-target-unavailable');
    const decisionOps = (edit: OfficeEditInput['edits'][number]) => edit.op === 'accept_revision' || edit.op === 'reject_revision';
    const commentOps = (edit: OfficeEditInput['edits'][number]) => edit.op === 'add_comment' || edit.op === 'reply_comment' || edit.op === 'resolve_comment';
    if (input.tracking && pkg.kind !== 'docx') return fail('track-changes-unsupported-kind');
    // Whole request first: a change this editor cannot record as a tracked revision is refused before anything is written.
    if (input.tracking && input.edits.some(edit => edit.op === 'replace_image' || edit.op === 'set_theme_tokens')) return fail('edit-not-trackable');
    for (const edit of input.edits) {
      const target = selected.get(edit.target_ref)!;
      if ((target.kind === 'revision') !== decisionOps(edit) || decisionOps(edit) && pkg.kind !== 'docx') return fail('unsupported-edit-target');
      if ((target.kind === 'comment') !== (edit.op === 'reply_comment' || edit.op === 'resolve_comment') || commentOps(edit) && pkg.kind !== 'docx'
        || edit.op === 'add_comment' && target.kind !== 'paragraph') return fail('unsupported-edit-target');
      if (decisionOps(edit) || commentOps(edit)) continue;
      if (edit.op === 'insert_generated_slide') {
        if (pkg.kind !== 'pptx' || target.kind !== 'slide' && !(target.kind === 'part' && target.id === pkg.main.ref)) return fail('unsupported-edit-target');
        continue;
      }
      if ((target.kind === 'part') !== (edit.op === 'set_theme_tokens')) return fail('unsupported-edit-target');
      if (edit.op === 'set_theme_tokens') {
        const type = input.manifest.parts.find(part => part.ref === target.id)?.contentType;
        if (type !== 'application/vnd.openxmlformats-officedocument.theme+xml' && type !== 'application/vnd.openxmlformats-officedocument.themeOverride+xml') return fail('unsupported-edit-target');
      }
      if ((target.kind === 'slide') !== (edit.op === 'duplicate_slide' || edit.op === 'remove_slide')) return fail('unsupported-edit-target');
      if (edit.op === 'duplicate_slide' || edit.op === 'remove_slide') {
        if (pkg.kind !== 'pptx') return fail('unsupported-edit-target');
        const part = input.manifest.parts.find(part => part.ref === target.record.part_ref)!;
        for (const name of await officeSlideOwnedParts(pkg, part.name)) wanted.add(name);
      }
    }
    if (input.edits.some(edit => edit.op === 'remove_slide')) for (const name of pkg.zip.names()) if (/\/_RELS\/[^/]*\.RELS$/i.test(name)) wanted.add(name);
    if (pkg.template) wanted.add('/[CONTENT_TYPES].XML');
    const before = new Map<string, { member: string; hash: string; ref: string }>(); const data = new Map<string, Buffer>();
    for (const name of pkg.zip.names().sort()) {
      const hash = createHash('sha256'); const chunks: Buffer[] = [];
      for await (const chunk of pkg.zip.bytes(name)) { hash.update(chunk); if (wanted.has(name)) chunks.push(Buffer.from(chunk)); }
      before.set(name, { member: pkg.zip.memberName(name), hash: hash.digest('hex'), ref: pkg.part(name)?.ref ?? 'content-types' });
      if (wanted.has(name)) data.set(name, Buffer.concat(chunks)); progress();
    }
    const zip = await JSZip.loadAsync(source, { createFolders: false });
    for (const [name, entry] of Object.entries(zip.files)) if (!entry.dir) {
      let canonical: string; try { canonical = opcPartName('/' + name); } catch { return fail('unsupported-package-preservation'); }
      const original = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? name;
      if (original !== name || before.get(canonical)?.member !== name) return fail('unsupported-package-preservation');
    }
    const copy = pkg.kind === 'pptx' ? await PresentationSlideCopy.create(pkg, data, before, progress) : undefined;
    const wordMedia = pkg.kind === 'docx' ? new OfficeWordMedia(pkg, data, before, progress) : undefined;
    const additions = copy?.added ?? wordMedia!.added;
    const images = new Map<string, { bytes: Buffer; receipt: PresentationImageReceipt }>();
    const charts: OfficeChartFact[] = []; const themes: NonNullable<OfficeEditResult['themes']> = []; const insertedSlides: NonNullable<OfficeEditResult['insertedSlides']> = []; let embeddedSignatures = false;
    const readPart = async (name: string) => { const chunks: Buffer[] = []; for await (const chunk of pkg.zip.bytes(name)) { chunks.push(Buffer.from(chunk)); progress(); } return Buffer.concat(chunks); };
    const changes: OfficeEditResult['changes'] = []; const slides: NonNullable<OfficeEditResult['slides']> = []; const removedSlides: NonNullable<OfficeEditResult['removedSlides']> = []; const shapes: NonNullable<OfficeEditResult['shapes']> = [];
    const wordOrders = new Map([[pkg.main.name, new OfficeWordParagraphOrder(input.manifest.paragraphs)]]); const insertedParagraphs: NonNullable<OfficeEditResult['insertedParagraphs']> = [];
    const wordTableOrders = new Map([[pkg.main.name, new OfficeWordTableOrder(input.manifest.tables)]]); const insertedTables: NonNullable<OfficeEditResult['insertedTables']> = [];
    for (const story of input.manifest.stories ?? []) { const name = input.manifest.parts.find(part => part.ref === story.part_ref)?.name; if (name) { wordOrders.set(name, new OfficeWordParagraphOrder(story.paragraphs)); wordTableOrders.set(name, new OfficeWordTableOrder(story.tables)); } }
    const storyParts = new Set<string>();
    const regionTextEdits: string[] = [];
    // Tracked Word edits and revision decisions share one ID allocator and one read-back over every story part.
    const wordSession = pkg.kind === 'docx' && (input.tracking || input.edits.some(decisionOps) || input.edits.some(commentOps)) ? await WordEditSession.open(pkg, async name => data.get(name) ?? await readPart(name), progress) : undefined;
    const tracking: WordTrackingSession | undefined = input.tracking && wordSession ? { author: input.tracking.author, initials: input.tracking.initials, date: input.tracking.date, ids: wordSession.ids } : undefined;
    const revisionsDecided: NonNullable<OfficeEditResult['revisionsDecided']> = [];
    // Comments: one editor per request over the current comment parts; missing parts are created beside the main document.
    const commentParts = pkg.kind === 'docx' ? await wordCommentPartNames(pkg) : {}; const createdCommentParts: string[] = [];
    const commentStoryParts = [pkg.main.name, ...input.manifest.parts.filter(item => item.name !== pkg.main.name && /wordprocessingml\.(?:header|footer)\+xml$/i.test(item.contentType ?? '')).map(item => item.name)];
    const commentEditor = pkg.kind === 'docx' && input.edits.some(commentOps) ? new WordCommentEditor({
      read: async name => data.get(name) ?? await readPart(name), write: (name, bytes) => { data.set(name, bytes); }, parts: commentParts,
      create: async (key, bytes) => { const name = await wordMedia!.addRelatedPart(pkg.main.name, WORD_COMMENT_PARTS[key].member, bytes, WORD_COMMENT_PARTS[key].contentType, WORD_COMMENT_PARTS[key].type); createdCommentParts.push(name); return name; },
      storyParts: commentStoryParts,
      allocateId: () => wordSession!.ids.allocate(),
    }, input.commentAuthor ?? fail('invalid-office-edits'), progress) : undefined;
    const commentsAdded: Array<{ target_ref: string; kind: 'comment' | 'reply'; id: string }> = []; const commentsResolved: Array<{ target_ref: string; root: string }> = [];
    const controlTexts: NonNullable<OfficeEditResult['controlTexts']> = [];
    const bookmarkTexts: NonNullable<OfficeEditResult['bookmarkTexts']> = [];
    // The chart part a PPT chart frame currently shows after earlier edits of this request (a copy or an edited original).
    const chartParts = new Map<string, string>(); const chartTitles: NonNullable<OfficeEditResult['chartTitles']> = [];
    for (const edit of input.edits) {
      const target = selected.get(edit.target_ref)!; const part = input.manifest.parts.find(part => part.ref === target.record.part_ref)!;
      const story = input.manifest.stories?.find(story => story.part_ref === part.ref);
      const localRef = story ? target.record.local_ref : target.id;
      if (typeof localRef !== 'string' || story && target.id !== part.ref + '-' + localRef) return fail('edit-target-unavailable');
      const wordOrder = wordOrders.get(part.name)!; const wordTables = wordTableOrders.get(part.name)!;
      if (story) storyParts.add(part.ref);
      if (edit.op === 'insert_generated_slide') {
        if (!copy) return fail('unsupported-edit-target'); if (target.kind === 'slide') copy.currentPart(target.id, part.name);
        const supplied = input.donors?.find(donor => donor.snapshotRef === edit.donor_snapshot_ref); if (!supplied) return fail('snapshot-unavailable');
        if (supplied.manifest.kind !== 'pptx') return fail('donor-presentation-required');
        if (sha(await readFile(supplied.source)) !== supplied.manifest.sha256) return fail('source-changed');
        const donor = await OfficePackage.open(supplied.source, ratio, floor, progress);
        try {
          if (donor.kind !== 'pptx' || donor.macroEnabled || donor.parts.some(part => /vbaProject/i.test(part.contentType ?? ''))) return fail('macro-edit-unavailable');
          const donorTarget = targets({ ...input, directory: supplied.directory, manifest: supplied.manifest, edits: [{ op: 'remove_slide', target_ref: edit.donor_slide_ref }] }, progress).get(edit.donor_slide_ref)!;
          const donorPart = supplied.manifest.parts.find(part => part.ref === donorTarget.record.part_ref); if (!donorPart || donorTarget.kind !== 'slide') return fail('edit-target-unavailable');
          const result = await copy.insertDonor(donor, donorPart.name, edit.after_ref === undefined ? target.kind === 'slide' ? target.id : undefined : edit.after_ref);
          insertedSlides.push({ ...result, target_ref: target.id, donor_snapshot_ref: edit.donor_snapshot_ref, donor_slide_ref: edit.donor_slide_ref, donor_sha256: supplied.manifest.sha256 });
          changes.push({ target_ref: target.id, replacements: 1, changed_text_nodes: 0, line_endings_normalized: false });
        } finally { donor.close(); }
        progress(); continue;
      }
      if (edit.op === 'set_theme_tokens') {
        data.set(part.name, setOfficeThemeTokens(data.get(part.name)!, edit, progress));
        themes.push({ target_ref: edit.target_ref, ...(edit.colors ? { colors: edit.colors } : {}), ...(edit.fonts ? { fonts: edit.fonts } : {}) });
        changes.push({ target_ref: target.id, replacements: 1, changed_text_nodes: 0, line_endings_normalized: false }); progress(); continue;
      }
      if (edit.op === 'remove_slide') {
        if (!copy) return fail('unsupported-edit-target'); removedSlides.push(await copy.remove(target.id, part.name));
        changes.push({ target_ref: target.id, replacements: 1, changed_text_nodes: 0, line_endings_normalized: false }); progress(); continue;
      }
      if (edit.op === 'duplicate_slide') {
        if (!copy) return fail('unsupported-edit-target');
        slides.push(await copy.duplicate(target.id, part.name, edit.after_ref === undefined ? target.id : edit.after_ref));
        changes.push({ target_ref: target.id, replacements: 1, changed_text_nodes: 0, line_endings_normalized: false }); progress(); continue;
      }
      const region = target.kind === 'bookmark' || target.kind === 'content-control';
      if (region && (pkg.kind !== 'docx' || edit.op !== 'replace_text' && !(edit.op === 'set_control_text' && target.kind === 'content-control') && !(edit.op === 'set_bookmark_text' && target.kind === 'bookmark') || part.name !== pkg.main.name && !story)) return fail('unsupported-edit-target');
      const kind: OfficeTextTarget['kind'] = region ? 'region' : target.kind === 'object' ? 'object' : target.kind === 'paragraph' ? 'paragraph' : 'cell';
      const slideRef = /^S[1-9]\d*(?=-)/.exec(target.id)?.[0];
      const currentPart = copy && slideRef ? copy.currentPart(slideRef, part.name) : part.name; let original = data.get(currentPart)!;
      const adapter = story ? officeWordStory(original, story.story, progress) : undefined; if (adapter) original = adapter.bytes;
      const restoreStory = (bytes: Buffer) => adapter ? adapter.finish(bytes) : bytes;
      if (edit.op === 'add_comment') {
        const result = await commentEditor!.add(original, wordOrder.current(localRef), edit.find, edit.text); data.set(currentPart, restoreStory(result.bytes));
        commentsAdded.push({ target_ref: target.id, kind: 'comment', id: result.id }); changes.push({ target_ref: target.id, replacements: 1, changed_text_nodes: 0, line_endings_normalized: false }); progress(); continue;
      }
      if (edit.op === 'reply_comment' || edit.op === 'resolve_comment') {
        const commentId = String(target.record.word_id);
        if (edit.op === 'reply_comment') {
          // The parent's markers may be in the body or in a header/footer story; the reply goes into that same story.
          const stories = await Promise.all(commentStoryParts.map(async name => ({ name, bytes: data.get(name) ?? await readPart(name) })));
          const result = await commentEditor!.reply(stories, commentId, edit.text);
          data.set(result.name, result.bytes); commentsAdded.push({ target_ref: target.id, kind: 'reply', id: result.id });
        } else commentsResolved.push({ target_ref: target.id, root: (await commentEditor!.resolve(commentId)).root });
        changes.push({ target_ref: target.id, replacements: 1, changed_text_nodes: 0, line_endings_normalized: false }); progress(); continue;
      }
      if (edit.op === 'accept_revision' || edit.op === 'reject_revision') {
        const identity = { wordIds: Array.isArray(target.record.word_ids) ? target.record.word_ids as Array<string | null> : [target.record.word_id as string | null],
          kind: String(target.record.kind), author: target.record.author as string | null };
        const decision = edit.op === 'accept_revision' ? 'accept' : 'reject';
        const result = decideWordRevision(original, identity, decision, progress); wordSession!.noteDecision(currentPart, identity, decision);
        for (const removed of [...result.removedParagraphs].reverse()) wordOrder.removed(removed);
        for (const row of result.removedRows) wordTables.removedRow(row.table, row.row);
        data.set(currentPart, restoreStory(result.bytes));
        revisionsDecided.push({ target_ref: target.id, decision: decision === 'accept' ? 'accepted' : 'rejected',
          removed_paragraphs: result.removedParagraphs.map(ordinal => (story ? part.ref + '-' : '') + 'D' + ordinal) });
        changes.push({ target_ref: target.id, replacements: 1, changed_text_nodes: 0, line_endings_normalized: false }); progress(); continue;
      }
      if (edit.op === 'set_bookmark_text') {
        if (!region || target.kind !== 'bookmark') return fail('unsupported-edit-target');
        if (tracking) {
          const result = trackedAssignRegion(original, localRef, edit.text, tracking, progress); data.set(currentPart, restoreStory(result.bytes)); const normalized = edit.text.replace(/\r\n?/g, '\n') !== edit.text;
          bookmarkTexts.push({ target_ref: target.id, characters: result.characters, paragraphs_added: 0, line_endings_normalized: normalized });
          changes.push({ target_ref: target.id, replacements: 1, changed_text_nodes: result.bytes.equals(original) ? 0 : 1, line_endings_normalized: normalized }); progress(); continue;
        }
        const result = setOfficeBookmarkText(original, { ...edit, target_ref: localRef }, progress); wordOrder.inserted(result.paragraphInsertionOrdinal, result.paragraphsAdded); data.set(currentPart, restoreStory(result.bytes));
        bookmarkTexts.push({ target_ref: target.id, characters: result.characters, paragraphs_added: result.paragraphsAdded, line_endings_normalized: result.lineEndingsNormalized });
        changes.push({ target_ref: target.id, replacements: 1, changed_text_nodes: result.bytes.equals(original) ? 0 : 1, line_endings_normalized: result.lineEndingsNormalized }); progress(); continue;
      }
      if (edit.op === 'set_control_text') {
        if (!region || target.kind !== 'content-control') return fail('unsupported-edit-target');
        if (tracking) {
          const result = trackedAssignRegion(original, localRef, edit.text, tracking, progress); data.set(currentPart, restoreStory(result.bytes)); const normalized = edit.text.replace(/\r\n?/g, '\n') !== edit.text;
          controlTexts.push({ target_ref: target.id, characters: result.characters, paragraphs_added: 0, placeholder_flag_removed: false, binding_present: result.bindingPresent, line_endings_normalized: normalized });
          changes.push({ target_ref: target.id, replacements: 1, changed_text_nodes: result.bytes.equals(original) ? 0 : 1, line_endings_normalized: normalized }); progress(); continue;
        }
        const result = setOfficeControlText(original, { ...edit, target_ref: localRef }, progress); wordOrder.inserted(result.paragraphInsertionOrdinal, result.paragraphsAdded); data.set(currentPart, restoreStory(result.bytes));
        controlTexts.push({ target_ref: target.id, characters: result.characters, paragraphs_added: result.paragraphsAdded, placeholder_flag_removed: result.placeholderFlagRemoved,
          binding_present: result.bindingPresent, line_endings_normalized: result.lineEndingsNormalized });
        changes.push({ target_ref: target.id, replacements: 1, changed_text_nodes: result.bytes.equals(original) ? 0 : 1, line_endings_normalized: result.lineEndingsNormalized }); progress(); continue;
      }
      if (edit.op === 'insert_table') {
        if (pkg.kind !== 'docx' || target.kind !== 'paragraph' || part.name !== pkg.main.name && !story) return fail('unsupported-edit-target');
        const result = insertOfficeWordTable(original, wordOrder.current(localRef), edit, progress);
        const tableBytes = tracking ? trackInsertedTable(result.bytes, result.tableInsertionOrdinal, result.paragraphInsertionOrdinal, result.insertedParagraphs, result.rows * result.columns, tracking, progress) : result.bytes;
        wordOrder.inserted(result.paragraphInsertionOrdinal, result.insertedParagraphs); wordTables.inserted(result.tableInsertionOrdinal); data.set(currentPart, restoreStory(tableBytes));
        insertedTables.push({ target_ref: target.id, rows: result.rows, columns: result.columns, position: edit.position, header_row: edit.header_row,
          ...(edit.style_id === undefined ? {} : { style_id: edit.style_id }), trailing_paragraph: result.trailingParagraph, line_endings_normalized: result.lineEndingsNormalized });
        changes.push({ target_ref: target.id, replacements: 1, changed_text_nodes: result.insertedParagraphs, line_endings_normalized: result.lineEndingsNormalized }); progress(); continue;
      }
      if (edit.op === 'insert_paragraphs') {
        if (pkg.kind !== 'docx' || target.kind !== 'paragraph' || part.name !== pkg.main.name && !story) return fail('unsupported-edit-target');
        const result = insertOfficeWordParagraphs(original, wordOrder.current(localRef), edit.paragraphs, edit.position, progress);
        const paragraphBytes = tracking ? trackInsertedParagraphs(result.bytes, result.insertionOrdinal, result.inserted, tracking, progress) : result.bytes;
        wordOrder.inserted(result.insertionOrdinal, result.inserted); data.set(currentPart, restoreStory(paragraphBytes));
        const normalized = result.normalized.some((text, index) => text !== edit.paragraphs[index]);
        insertedParagraphs.push({ target_ref: target.id, paragraphs: result.inserted, position: edit.position, line_endings_normalized: normalized });
        changes.push({ target_ref: target.id, replacements: 1, changed_text_nodes: result.inserted, line_endings_normalized: normalized }); progress(); continue;
      }
      if (edit.op === 'set_shape_text') {
        if (!copy || !slideRef || target.kind !== 'object' || target.record.object_kind !== 'sp') return fail('unsupported-edit-target');
        const result = setOfficeShapeText(original, target.id, edit.text, progress); const changed = !result.bytes.equals(original);
        const outputPart = changed ? await copy.isolate(slideRef, part.name) : currentPart; data.set(outputPart, result.bytes);
        shapes.push({ target_ref: target.id, characters: result.characters, paragraphs: result.paragraphs, line_endings_normalized: result.lineEndingsNormalized });
        changes.push({ target_ref: target.id, replacements: 1, changed_text_nodes: changed ? result.paragraphs : 0, line_endings_normalized: result.lineEndingsNormalized }); progress(); continue;
      }
      if (edit.op === 'set_chart_title') {
        const chartIds = target.record.chart_relationships;
        if (!copy || !slideRef || target.kind !== 'object' || target.record.object_kind !== 'graphicFrame' || !Array.isArray(chartIds) || chartIds.length !== 1 || typeof chartIds[0] !== 'string') return fail('unsupported-edit-target');
        const relation = (await pkg.relations(part.name)).find(relation => relation.id === chartIds[0] && relation.kind === 'chart' && !relation.external && relation.target && pkg.part(relation.target));
        if (!relation?.target) return fail('edit-target-unavailable');
        // Only the chart part is written; its embedded workbook is never cloned. A shared chart part gets this frame's own copy.
        const current = chartParts.get(target.id);
        const result = setOfficeChartTitle(current ? data.get(current)! : await readPart(relation.target), edit.title, progress);
        let stored = current;
        if (stored) data.set(stored, result.bytes);
        else if (await copy.chartExclusive(slideRef, part.name, chartIds[0], relation.target)) { stored = relation.target; data.set(stored, result.bytes); }
        else {
          const added = await copy.copyChart(slideRef, part.name, chartIds[0], result.bytes); stored = added.chart;
          data.set(added.part, patchOfficeChartReference(data.get(added.part)!, target.id, added.relationship, progress));
        }
        chartParts.set(target.id, stored);
        chartTitles.push({ target_ref: target.id, title: edit.title === null ? null : edit.title.replace(/\r\n?/g, '\n'), paragraphs: result.paragraphs,
          chart_part_copied: stored !== relation.target, line_endings_normalized: result.lineEndingsNormalized });
        changes.push({ target_ref: target.id, replacements: 1, changed_text_nodes: 0, line_endings_normalized: result.lineEndingsNormalized }); progress(); continue;
      }
      if (edit.op === 'update_chart_data') {
        const chartIds = target.record.chart_relationships;
        if (!copy || !slideRef || target.kind !== 'object' || target.record.object_kind !== 'graphicFrame' || !Array.isArray(chartIds) || chartIds.length !== 1 || typeof chartIds[0] !== 'string') return fail('unsupported-edit-target');
        const relation = (await pkg.relations(part.name)).find(relation => relation.id === chartIds[0] && relation.kind === 'chart' && !relation.external && relation.target && pkg.part(relation.target));
        if (!relation?.target) return fail('edit-target-unavailable');
        // Start from this frame's current chart when an earlier edit of this request changed it (for example its title).
        const shown = chartParts.get(target.id);
        const chart = shown ? data.get(shown)! : await readPart(relation.target); const model = readOfficeChart(chart, progress);
        let values: ReturnType<typeof officeChartData>;
        try { values = officeChartData(edit, model.kind, input.bindings ?? [], progress); }
        catch (error) { if (error instanceof OfficeEditFailure) throw error; throw new OfficeEditFailure(error instanceof Error && error.message === 'snapshot-unavailable' ? 'chart-source-unavailable' : 'invalid-chart-data'); }
        const embedding = (await pkg.relations(relation.target)).find(relation => relation.id === model.embedded?.value && relation.kind === 'package' && !relation.external && relation.target && pkg.part(relation.target)?.contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        const workbook = await addOfficeChartSheet(embedding?.target ? await readPart(embedding.target) : await emptyOfficeChartWorkbook(), input.directory, values.rows, ratio, floor, progress);
        embeddedSignatures ||= workbook.signaturesPresent;
        const added = await copy.addChart(slideRef, part.name, chartIds[0], workbook.bytes,
          packageId => patchOfficeChart(chart, values.series, values.stride, workbook.sheet, packageId, progress));
        data.set(added.part, patchOfficeChartReference(data.get(added.part)!, target.id, added.relationship, progress)); charts.push(values.fact); chartParts.set(target.id, added.chart);
        changes.push({ target_ref: target.id, replacements: 1, changed_text_nodes: 0, line_endings_normalized: false }); progress(); continue;
      }
      if (edit.op === 'replace_image') {
        if (target.kind !== 'object' || target.record.object_kind !== 'pic' || pkg.kind === 'pptx' && (!copy || !slideRef) || pkg.kind === 'docx' && (part.name !== pkg.main.name && !story || !/^I[1-9]\d*$/.test(localRef))) return fail('unsupported-edit-target');
        let image = images.get(edit.asset_ref);
        if (!image) {
          const supplied = input.images?.find(image => image.assetRef === edit.asset_ref); if (!supplied) return fail('image-unavailable');
          const bytes = Buffer.from(supplied.bytes); const budget = Math.floor(getHeapStatistics().heap_size_limit / 8);
          const jpeg = bytes[0] === 255 && bytes[1] === 216 ? decodeJpeg(bytes, budget) : undefined;
          const pixels = jpeg ?? decodePng(bytes, budget); if (pixels.sha256 !== supplied.sha256) return fail('invalid-image');
          image = { bytes: jpeg?.png ?? bytes, receipt: { assetRef: edit.asset_ref, sha256: pixels.sha256, width: pixels.width, height: pixels.height, placements: 0,
            ...(jpeg ? { sourceMimeType: 'image/jpeg', embeddedSha256: jpeg.embeddedSha256, orientation: jpeg.orientation, colorProfile: jpeg.colorProfile } : {}) } };
          images.set(edit.asset_ref, image);
        }
        if (wordMedia) {
          patchWordPicture(original, localRef, 'rId_preview', image.receipt.width, image.receipt.height, edit, progress);
          const sourcePicture = wordPictureElements(original, progress).pictures[Number(localRef.slice(1)) - 1];
          const relationship = await wordMedia.addPicture(currentPart, image.bytes, sourcePicture.tag.uri.startsWith('http://purl.oclc.org/'));
          data.set(currentPart, restoreStory(patchWordPicture(original, localRef, relationship, image.receipt.width, image.receipt.height, edit, progress)));
          image.receipt.placements++; changes.push({ target_ref: target.id, replacements: 1, changed_text_nodes: 0, line_endings_normalized: false }); progress(); continue;
        }
        if (!copy || !slideRef) return fail('unsupported-edit-target');
        // Validate the selected picture and geometry before adding or forking any package member.
        const geometry = target.record.geometry_emu as Record<string, string> | undefined;
        const inherited = ['off_x', 'off_y', 'ext_cx', 'ext_cy'].every(key => geometry?.[key] !== undefined) ? undefined
          : await inheritedPictureGeometry(pkg, part.name, target.record.placeholder);
        patchOfficePicture(original, target.id, 'rId_preview', image.receipt.width, image.receipt.height, edit, progress, inherited);
        const added = await copy.addPicture(slideRef, part.name, image.bytes);
        data.set(added.part, patchOfficePicture(data.get(added.part)!, target.id, added.relationship, image.receipt.width, image.receipt.height, edit, progress, inherited));
        image.receipt.placements++; changes.push({ target_ref: target.id, replacements: 1, changed_text_nodes: 0, line_endings_normalized: false }); progress(); continue;
      }
      if (edit.op !== 'replace_text') return fail('unsupported-edit-target');
      const textRef = pkg.kind === 'docx' && target.kind === 'paragraph' ? 'D' + wordOrder.current(localRef) : pkg.kind === 'docx' && target.kind === 'table-cell' ? wordTables.currentCell(localRef) : localRef;
      const trackedTarget = (): Parameters<typeof trackedReplaceText>[1] => kind === 'paragraph' ? { kind, ordinal: Number(textRef.slice(1)) } : kind === 'cell' ? { kind, ref: textRef } : { kind: 'region', ref: textRef };
      const tracked = tracking && pkg.kind === 'docx' ? trackedReplaceText(original, trackedTarget(), edit.find, edit.replace, edit.all, tracking, progress) : undefined;
      const result = tracked ? { bytes: tracked.bytes, replacements: tracked.replacements, changedTextNodes: tracked.revisions, lineEndingsNormalized: edit.replace.replace(/\r\n?/g, '\n') !== edit.replace }
        : replaceOfficeText(original, pkg.kind, { kind, ref: textRef, slideRef }, edit.find, edit.replace, edit.all, progress);
      const outputPart = copy && slideRef && !result.bytes.equals(original) ? await copy.isolate(slideRef, part.name) : currentPart;
      data.set(outputPart, restoreStory(result.bytes)); changes.push({ target_ref: target.id, replacements: result.replacements,
        changed_text_nodes: result.changedTextNodes, line_endings_normalized: result.lineEndingsNormalized }); progress();
      if (region) regionTextEdits.push(target.id);
    }
    // Read-back of tracked changes and decisions: annotation IDs, rollback projection, author/date of each new revision.
    const added = wordSession ? wordSession.verify(name => data.get(name), tracking, progress, createdCommentParts) : [];
    const finalComments = commentEditor && commentParts.comments ? wordComments({ comments: data.get(commentParts.comments) ?? await readPart(commentParts.comments) }, progress).comments : [];
    const commentRef = (id: string) => { const index = finalComments.findIndex(comment => comment.id === id); return index < 0 ? fail('office-output-check-failed') : `M${index + 1}`; };
    const partRef = (name: string) => input.manifest.parts.find(item => item.name === name)?.ref ?? fail('office-output-check-failed');
    const revisionsAdded = added.map(revision => ({ revision_ref_new: `${revision.story === 'main' ? '' : partRef(revision.part) + '-'}R${revision.ordinal}`,
      kind: revision.kind, author: revision.author, story_ref: partRef(revision.part) }));
    const finalSlideCount = input.manifest.slides + slides.length + insertedSlides.length - removedSlides.length;
    const removal = copy ? await copy.finishRemovals(finalSlideCount) : { retained: 0 };
    const removedThumbnailParts = copy ? await copy.dropStaleThumbnail() : [];
    if (pkg.template) data.set('/[CONTENT_TYPES].XML', convertTemplate(data.get('/[CONTENT_TYPES].XML')!, pkg.main.name, pkg.kind, progress));
    const changed = new Map([...data].filter(([name, bytes]) => !before.has(name) || sha(bytes) !== before.get(name)!.hash));
    // A written member never adds folder entries the source package did not have.
    for (const [name, bytes] of changed) zip.file(before.get(name)?.member ?? additions.get(name)?.member ?? fail('office-preservation-check-failed'), bytes, { createFolders: false });
    for (const name of copy?.removed ?? []) zip.remove(before.get(name)!.member);
    const output = changed.size || copy?.removed.size ? await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }, () => progress()) : source;
    const temporary = join(input.directory, `edited-${randomUUID()}.zip`); await writeFile(temporary, output, { flag: 'wx' });
    const checked = await OfficePackage.open(temporary, ratio, floor, progress); let preserved = 0; const digest = createHash('sha256');
    try {
      if (checked.kind !== pkg.kind || checked.template || checked.macroEnabled || checked.zip.names().length !== before.size + additions.size - (copy?.removed.size ?? 0)) return fail('office-preservation-check-failed');
      if (slides.length || insertedSlides.length || removedSlides.length) await copy!.verifySlideList(checked, finalSlideCount);
      for (const [name, original] of before) {
        if (copy?.removed.has(name)) { if (checked.zip.has(name)) return fail('office-preservation-check-failed'); continue; }
        if (checked.zip.memberName(name) !== original.member) return fail('office-preservation-check-failed');
        const hash = createHash('sha256'); for await (const chunk of checked.zip.bytes(name)) hash.update(chunk); const actual = hash.digest('hex');
        if (actual !== (changed.has(name) ? sha(changed.get(name)!) : original.hash)) return fail('office-preservation-check-failed');
        if (!changed.has(name)) { preserved++; digest.update(JSON.stringify([original.ref, actual])); } progress();
      }
      for (const [name, added] of additions) {
        if (checked.zip.memberName(name) !== added.member || checked.part(name)?.contentType !== added.contentType) return fail('office-preservation-check-failed');
        const hash = createHash('sha256'); for await (const chunk of checked.zip.bytes(name)) hash.update(chunk);
        if (hash.digest('hex') !== sha(data.get(name)!)) return fail('office-preservation-check-failed'); progress();
      }
    } finally { checked.close(); }
    return { bytes: output, sha256: sha(output), sourceSha256: input.manifest.sha256, kind: pkg.kind, preservedParts: preserved,
      preservationDigest: digest.digest('hex'), changedParts: [...changed.keys()].map(name => before.get(name)?.ref ?? additions.get(name)!.ref), addedParts: additions.size, changes,
      templateConverted: pkg.template, signaturesPresent: embeddedSignatures || pkg.parts.some(part => /digital-signature/i.test(part.contentType ?? '')),
      ...(images.size ? { images: [...images.values()].map(image => image.receipt) } : {}), ...(charts.length ? { charts } : {}), ...(slides.length ? { slides } : {}),
      ...(shapes.length ? { shapes } : {}),
      ...(chartTitles.length ? { chartTitles } : {}),
      ...(themes.length ? { themes } : {}),
      ...(insertedSlides.length ? { insertedSlides } : {}),
      ...(pkg.kind === 'docx' ? { tracked: !!tracking } : {}), ...(tracking ? { author: { name: input.tracking!.author, source: input.tracking!.authorSource }, revisionsAdded } : {}),
      ...(revisionsDecided.length ? { revisionsDecided } : {}),
      ...(commentsAdded.length ? { commentsAdded: commentsAdded.map(item => ({ target_ref: item.target_ref, kind: item.kind, comment_ref_new: commentRef(item.id), author: input.commentAuthor!.author })) } : {}),
      ...(commentsResolved.length ? { commentsResolved: commentsResolved.map(item => ({ target_ref: item.target_ref, thread_root_ref: commentRef(item.root) })) } : {}),
      ...(insertedParagraphs.length ? { insertedParagraphs } : {}),
      ...(insertedTables.length ? { insertedTables } : {}),
      ...(regionTextEdits.length ? { regionTextEdits } : {}),
      ...(storyParts.size ? { storyParts: [...storyParts] } : {}),
      ...(controlTexts.length ? { controlTexts } : {}),
      ...(bookmarkTexts.length ? { bookmarkTexts } : {}),
      ...(copy?.removed.size ? { removedParts: [...copy.removed].map(name => before.get(name)!.ref) } : {}),
      ...(removedThumbnailParts.length ? { removedThumbnailParts: removedThumbnailParts.map(name => before.get(name)!.ref) } : {}),
      ...(removedSlides.length ? { removedSlides, retainedRemovalParts: removal.retained, removalMetadataUnavailable: removal.metadataUnavailable ?? false } : {}) };
  } finally { pkg.close(); }
}
