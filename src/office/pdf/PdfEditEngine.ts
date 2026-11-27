import { createHash } from 'node:crypto';
import {
  PDFArray, PDFButton, PDFCheckBox, PDFDict, PDFDocument, PDFDropdown, PDFHexString, PDFName, PDFNumber, PDFOptionList, PDFRadioGroup, PDFRawStream, PDFRef,
  PDFSignature, PDFStream, PDFString, PDFTextField,
  beginText, degrees, endText, popGraphicsState, pushGraphicsState, setFillingRgbColor, setFontAndSize, setGraphicsState, setTextMatrix, showText,
  type PDFFont, type PDFField, type PDFPage,
} from 'pdf-lib';
import { DocumentFailure } from '../../content/document/DocumentContracts';
import { selectDocumentFontFace, type PublicFontkit } from '../../content/document/FontFaceSelection';
import { bindSubsetPdfFontAdapter, positionedPdfGlyphs } from '../../content/document/PdfFontAdapter';
import type { PdfFontSource } from '../../content/document/PdfRenderer';
import {
  PdfEditFailure, parsePageList, type PdfEditFacts, type PdfEditOperation, type PdfEditOperationFact, type PdfEditResult, type PageNumberPosition, type PdfRect,
} from './PdfEditContracts';
import {
  cleanupForDeletedPages, documentLevelStructures, hasDigitalSignature, hasFormFields, hasXfa, materializeInherited, normalizedBox,
} from './PdfStructure';

/** Text items of one page as PDF.js reports them (user-space transform). */
export interface PdfTextItem { str: string; transform: number[]; width: number; height: number }
export interface PdfTextPort { pages(bytes: Uint8Array): Promise<PdfTextItem[][]> }
export interface PdfEngineSource { bytes: Uint8Array; sha256: string }
/** Operations whose replace_pages source is resolved to an index into `sources`. */
export type PdfEngineOperation = Exclude<PdfEditOperation, { op: 'replace_pages' } | { op: 'add_image' } | { op: 'place_signature' }>
  | { op: 'replace_pages'; pages: string; from: { source: number; pages?: string } }
  | { op: 'add_image'; page: number; rect: PdfRect; image: number };
/** Host-loaded image bytes; the engine never sees an asset reference, path or URL. */
export interface PdfEngineImage { bytes: Uint8Array; sha256: string; mime: 'image/png' | 'image/jpeg' }
export interface PdfEngineInput {
  sources: PdfEngineSource[]; inputCount: number; operations: PdfEngineOperation[]; flattenFormsBeforeMerge: boolean;
  /** Host-read font candidates by overlay language; the engine never opens a path. */
  fonts: Record<string, PdfFontSource[]>;
  images?: PdfEngineImage[];
  /**
   * The signing phase (13.13): with no operations and one source (the confirmed candidate), place each confirmed
   * signature image in its visible rectangle. Nothing else changes.
   */
  signatures?: Array<{ page: number; rect: PdfRect; image: PdfEngineImage }>;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fingerprint = (items: PdfTextItem[]) => sha256(Buffer.from(JSON.stringify(items.map(item => item.str.normalize('NFC'))), 'utf8'));
const squash = (text: string) => text.normalize('NFC').replace(/\s+/g, '');

/** The overlay language decides the font profile; Han without kana or hangul uses the Simplified Chinese profile. */
export function pdfTextLanguage(text: string): string {
  if (/\p{Script=Hangul}/u.test(text)) return 'ko';
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja';
  if (/\p{Script=Han}/u.test(text)) return 'zh-Hans';
  return 'en';
}

/** Every language the request's overlay or form text needs, so the host reads only those font candidates. */
export function pdfEditLanguages(operations: readonly PdfEditOperation[]): string[] {
  const texts = operations.flatMap(operation => operation.op === 'add_watermark' || operation.op === 'add_text' ? [operation.text]
    : operation.op === 'add_page_numbers' ? [operation.format.replace(/\{n\}|\{total\}/g, '0')]
      : operation.op === 'fill_form' ? [formFontText(operation.fields)].filter(Boolean) : []);
  return [...new Set(texts.map(pdfTextLanguage))].sort();
}
function formFontText(fields: Record<string, string | boolean | string[]>): string {
  return Object.values(fields).flatMap(value => typeof value === 'string' ? [value] : Array.isArray(value) ? value : []).join('');
}

/**
 * The visible page frame (13.12): points, origin at the CropBox top-left, upright as /Rotate shows it. Converts to PDF
 * user space with the CropBox offset, /Rotate (0, 90, 180, 270) and /UserUnit.
 */
export interface VisibleGeometry { width: number; height: number; rotation: number; unit: number; crop: [number, number, number, number] }
export function visibleGeometry(page: PDFPage): VisibleGeometry {
  const crop = normalizedBox(page.getCropBox()); const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  if (rotation % 90 !== 0) throw new PdfEditFailure('pdf-invalid');
  const unit = page.node.lookupMaybe(PDFName.of('UserUnit'), PDFNumber)?.asNumber() ?? 1;
  if (!Number.isFinite(unit) || unit <= 0) throw new PdfEditFailure('pdf-invalid');
  const w = (crop[2] - crop[0]) * unit; const h = (crop[3] - crop[1]) * unit;
  return rotation % 180 === 0 ? { width: w, height: h, rotation, unit, crop } : { width: h, height: w, rotation, unit, crop };
}
/** Visible (x right, y down, points) to user space. */
export function visibleToUser(geometry: VisibleGeometry, vx: number, vy: number): [number, number] {
  const a = vx / geometry.unit; const b = vy / geometry.unit; const [x0, y0, x1, y1] = geometry.crop;
  switch (geometry.rotation) {
    case 90: return [x0 + b, y0 + a];
    case 180: return [x1 - a, y0 + b];
    case 270: return [x1 - b, y1 - a];
    default: return [x0 + a, y1 - b];
  }
}
/** User space to visible (x right, y down, points). The exact inverse of visibleToUser. */
export function userToVisible(geometry: VisibleGeometry, x: number, y: number): [number, number] {
  const [x0, y0, x1, y1] = geometry.crop; const u = geometry.unit;
  switch (geometry.rotation) {
    case 90: return [(y - y0) * u, (x - x0) * u];
    case 180: return [(x1 - x) * u, (y - y0) * u];
    case 270: return [(y1 - y) * u, (x1 - x) * u];
    default: return [(x - x0) * u, (y1 - y) * u];
  }
}

interface FontUse { embedded: PDFFont; adapter: ReturnType<typeof bindSubsetPdfFontAdapter>; units: number; ascent: number; descent: number; language: string; family: string; sha256: string }
interface PageState {
  source: number; page: number; overlays: string[]; prefixOnly: boolean; rotation: number; images: number; annotations: string[];
  /** Indexes of the annotation/image operation facts that live on this page. */
  facts: { annotations: number[]; images: number[] };
}
interface Working { doc: PDFDocument; pages: PageState[]; fonts: Map<string, FontUse>; inPlace: boolean; dropped: Set<string> }

export async function runPdfEdit(input: PdfEngineInput, text: PdfTextPort, signal?: { aborted: boolean }): Promise<PdfEditResult> {
  const check = () => { if (signal?.aborted) throw new PdfEditFailure('cancelled'); };
  const fontkit = require('fontkit') as PublicFontkit;
  const loaded: PDFDocument[] = [];
  for (const source of input.sources) {
    if (sha256(source.bytes) !== source.sha256) throw new PdfEditFailure('source-changed');
    let doc: PDFDocument;
    // Loaded with ignoreEncryption only to read the trailer: an encrypted input is refused before any other use.
    try { doc = await PDFDocument.load(source.bytes, { updateMetadata: false, ignoreEncryption: true }); }
    catch { throw new PdfEditFailure('pdf-invalid'); }
    if (doc.isEncrypted) throw new PdfEditFailure('pdf-encrypted');
    if (hasXfa(doc)) throw new PdfEditFailure('pdf-xfa-unsupported');
    if (hasDigitalSignature(doc)) throw new PdfEditFailure('pdf-signed');
    if (doc.getPageCount() < 1) throw new PdfEditFailure('pdf-invalid');
    loaded.push(doc); check();
  }
  const sourceTexts: PdfTextItem[][][] = [];
  for (const source of input.sources) { sourceTexts.push(await text.pages(source.bytes)); check(); }
  loaded.forEach((doc, index) => { if (sourceTexts[index].length !== doc.getPageCount()) throw new PdfEditFailure('pdf-invalid'); });
  const sourceBoxes = loaded.map(doc => doc.getPages().map(page => ({ media: normalizedBox(page.getMediaBox()), crop: normalizedBox(page.getCropBox()), rotation: visibleGeometry(page).rotation, images: imageCount(page) })));
  const facts: PdfEditFacts = { sha256: '', pages: 0, sources: input.sources.map((source, index) => ({ sha256: source.sha256, pages: loaded[index].getPageCount() })),
    operations: [], page_map: [], removed: { fields: [], widgets: 0, outline_items: [], outline_destinations: [], links: 0 }, dropped: [],
    forms: { fields: [], filled: [], flattened: false, flattened_inputs: [] }, fonts: [], checks: { page_boxes: 0, text_fingerprints: 0, overlay_pages: 0, field_values: 0, annotations: 0, images: 0 },
    annotations: [], images: [], signatures: [], page_identity: [], page_text_head: [] };
  const fresh0 = (source: number, page: number): PageState => ({ source, page, overlays: [], prefixOnly: false, rotation: sourceBoxes[source][page - 1].rotation, images: 0, annotations: [], facts: { annotations: [], images: [] } });
  if (input.signatures?.length && (input.operations.length || input.sources.length !== 1)) throw new PdfEditFailure('invalid-pdf-edits');
  /** A copyPages route cannot carry AcroForm fields (13.11): refuse, or flatten first only when the request says so. */
  const formsAllowedAcrossCopy = (doc: PDFDocument, sourceIndex?: number): boolean => {
    if (!hasFormFields(doc)) return false;
    if (!input.flattenFormsBeforeMerge) throw new PdfEditFailure('pdf-form-merge-unsupported');
    try { doc.getForm().flatten({ updateFieldAppearances: false }); } catch { throw new PdfEditFailure('pdf-form-flatten-failed'); }
    if (sourceIndex !== undefined && !facts.forms.flattened_inputs.includes(sourceIndex)) facts.forms.flattened_inputs.push(sourceIndex);
    else if (sourceIndex === undefined) facts.forms.flattened = true;
    return true;
  };
  const fresh = async (from: PDFDocument): Promise<PDFDocument> => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const title = from.getTitle(); const author = from.getAuthor(); const subject = from.getSubject(); const keywords = from.getKeywords(); const creator = from.getCreator();
    if (title) doc.setTitle(title); if (author) doc.setAuthor(author); if (subject) doc.setSubject(subject); if (keywords) doc.setKeywords(keywords.split(/\s+/)); if (creator) doc.setCreator(creator);
    return doc;
  };
  let working: Working;
  const operations = [...input.operations];
  if (operations[0]?.op === 'merge') {
    operations.shift();
    for (let index = 0; index < input.inputCount; index++) formsAllowedAcrossCopy(loaded[index], index);
    const doc = await fresh(loaded[0]); const pages: PageState[] = []; const dropped = new Set<string>();
    for (let index = 0; index < input.inputCount; index++) {
      documentLevelStructures(loaded[index]).forEach(item => dropped.add(item));
      const copies = await doc.copyPages(loaded[index], loaded[index].getPageIndices());
      copies.forEach((page, pageIndex) => { doc.addPage(page); pages.push({ ...fresh0(index, pageIndex + 1), prefixOnly: facts.forms.flattened_inputs.includes(index) }); });
      check();
    }
    working = { doc, pages, fonts: new Map(), inPlace: false, dropped };
    facts.operations.push({ op: 'merge', pages: pages.map((_page, index) => index + 1), result: 'applied', detail: `${input.inputCount} inputs` });
  } else {
    const doc = loaded[0];
    working = { doc, pages: doc.getPages().map((_page, index) => fresh0(0, index + 1)), fonts: new Map(), inPlace: true, dropped: new Set() };
  }
  const select = (spec: string | undefined, count = working.doc.getPageCount()): number[] => {
    const pages = spec === undefined ? Array.from({ length: count }, (_value, index) => index + 1) : parsePageList(spec);
    if (pages.some(page => page > count) || new Set(pages).size !== pages.length) throw new PdfEditFailure('invalid-pages');
    return pages;
  };
  /** A copyPages route: flush pending fonts first (their objects are written then), and start a new font cache. */
  const rebuild = async (entries: Array<{ doc: PDFDocument; index: number; state: PageState }>, from: PDFDocument) => {
    await working.doc.flush();
    const doc = await fresh(from); const pages: PageState[] = [];
    for (const entry of entries) {
      const [copy] = await doc.copyPages(entry.doc, [entry.index]); doc.addPage(copy); pages.push({ ...entry.state, overlays: [...entry.state.overlays], annotations: [...entry.state.annotations],
        facts: { annotations: [...entry.state.facts.annotations], images: [...entry.state.facts.images] } });
    }
    documentLevelStructures(working.doc).forEach(item => working.dropped.add(item));
    working = { doc, pages, fonts: new Map(), inPlace: false, dropped: working.dropped };
  };
  const font = async (language: string): Promise<FontUse> => {
    const cached = working.fonts.get(language); if (cached) return cached;
    let selected: { face: any; metadata: ReturnType<typeof selectDocumentFontFace>['metadata']; source: PdfFontSource } | undefined;
    for (const source of input.fonts[language] ?? []) {
      if (sha256(new Uint8Array(source.bytes)) !== source.sha256) throw new PdfEditFailure('font-unavailable');
      try { selected = { ...selectDocumentFontFace(fontkit, new Uint8Array(source.bytes), { family: source.family, style: 'regular' }), source }; break; }
      catch (error) { if (!(error instanceof DocumentFailure)) throw error; }
    }
    if (!selected) throw new PdfEditFailure('font-unavailable', { location: language, issue: 'no embeddable font' });
    const [script, otLanguage] = /^ko/.test(language) ? ['hang', 'KOR'] : /^ja/.test(language) ? ['hani', 'JAN'] : /^zh/.test(language) ? ['hani', 'ZHS'] : ['latn', 'ENG'];
    const adapter = bindSubsetPdfFontAdapter(selected.face, new Uint8Array(selected.source.bytes), selected.metadata, script, otLanguage);
    working.doc.registerFontkit(adapter.fontkit as any);
    const embedded = await working.doc.embedFont(selected.source.bytes, { subset: true });
    const use: FontUse = { embedded, adapter, units: selected.face.unitsPerEm, ascent: selected.face.ascent, descent: selected.face.descent, language, family: selected.source.family, sha256: selected.source.sha256 };
    if (![use.units, use.ascent, use.descent].every(Number.isFinite) || use.units <= 0) throw new PdfEditFailure('font-unavailable');
    working.fonts.set(language, use);
    if (!facts.fonts.some(item => item.sha256 === use.sha256 && item.language === language)) facts.fonts.push({ language, family: use.family, sha256: use.sha256 });
    return use;
  };
  const shape = (use: FontUse, value: string) => {
    try { return use.adapter.layout(value); } catch (error) {
      throw new PdfEditFailure(error instanceof DocumentFailure && error.code === 'unsupported-glyph' ? 'unsupported-glyph' : 'font-unavailable');
    }
  };
  /** Draw one upright line at an upright-frame origin (x right, y up, points) turned `angle` degrees counter-clockwise. */
  const drawText = async (page: PDFPage, value: string, size: number, origin: [number, number], angle: number, color: [number, number, number], opacity?: number) => {
    const use = await font(pdfTextLanguage(value)); const geometry = visibleGeometry(page);
    const run = shape(use, value);
    const positions = positionedPdfGlyphs(run, use.embedded.encodeText(value).asString(), use.units, size, 0, 0);
    const name = page.node.newFontDictionary('UnodeF', use.embedded.ref);
    const operators = [pushGraphicsState()];
    if (opacity !== undefined && opacity < 1) {
      const state = working.doc.context.register(working.doc.context.obj({ Type: 'ExtGState', ca: opacity, CA: opacity }));
      operators.push(setGraphicsState(page.node.newExtGState('UnodeGS', state)));
    }
    const radians = angle * Math.PI / 180; const cos = Math.cos(radians); const sin = Math.sin(radians);
    const userAngle = (geometry.rotation + angle) * Math.PI / 180; const ucos = Math.cos(userAngle); const usin = Math.sin(userAngle);
    operators.push(setFillingRgbColor(...color), beginText(), setFontAndSize(name, size / geometry.unit));
    for (const glyph of positions) {
      const ux = origin[0] + glyph.x * cos - glyph.y * sin; const uy = origin[1] + glyph.x * sin + glyph.y * cos;
      const [x, y] = visibleToUser(geometry, ux, geometry.height - uy);
      operators.push(setTextMatrix(ucos, usin, -usin, ucos, x, y), showText(PDFHexString.of(glyph.cidHex)));
    }
    operators.push(endText(), popGraphicsState());
    page.pushOperators(...operators);
    return { width: run.positions.reduce((sum, position) => sum + position.xAdvance, 0) * size / use.units, use };
  };
  const measure = async (value: string, size: number) => {
    const use = await font(pdfTextLanguage(value)); const run = shape(use, value);
    return { width: run.positions.reduce((sum, position) => sum + position.xAdvance, 0) * size / use.units, ascent: use.ascent * size / use.units, descent: use.descent * size / use.units };
  };
  const rgb = (hex: string): [number, number, number] => [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255) as [number, number, number];
  const onePage = (number: number): PDFPage => { if (number > working.doc.getPageCount()) throw new PdfEditFailure('invalid-pages'); return working.doc.getPage(number - 1); };
  const insideVisible = (page: PDFPage, rect: PdfRect, location: string) => {
    const geometry = visibleGeometry(page);
    if (rect[0] + rect[2] > geometry.width + 1e-6 || rect[1] + rect[3] > geometry.height + 1e-6) {
      throw new PdfEditFailure('invalid-pdf-edits', { location, issue: `The rectangle lies outside the visible page (${round(geometry.width)} x ${round(geometry.height)} pt).` });
    }
  };
  /** Visible rectangle to a user-space quad: top-left, top-right, bottom-left, bottom-right. */
  const visibleQuad = (geometry: VisibleGeometry, [x, y, w, h]: PdfRect): number[] => [
    ...visibleToUser(geometry, x, y), ...visibleToUser(geometry, x + w, y), ...visibleToUser(geometry, x, y + h), ...visibleToUser(geometry, x + w, y + h)];
  const boundsOf = (quads: number[][]): number[] => {
    const xs = quads.flatMap(quad => [quad[0], quad[2], quad[4], quad[6]]); const ys = quads.flatMap(quad => [quad[1], quad[3], quad[5], quad[7]]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const addAnnotation = (page: PDFPage, entries: Record<string, unknown>) => {
    const ref = working.doc.context.register(working.doc.context.obj({ Type: 'Annot', P: page.ref, F: 4, M: PDFString.fromDate(new Date()), ...entries } as any));
    page.node.addAnnot(ref); return ref;
  };
  /** Contain-fit an image in a visible rectangle, upright as the page is seen. */
  const drawImageIn = async (page: PDFPage, image: PdfEngineImage, rect: PdfRect) => {
    let embedded;
    try { embedded = image.mime === 'image/png' ? await working.doc.embedPng(image.bytes) : await working.doc.embedJpg(image.bytes); }
    catch { throw new PdfEditFailure('unsupported-image'); }
    const geometry = visibleGeometry(page); const scale = Math.min(rect[2] / embedded.width, rect[3] / embedded.height);
    const width = embedded.width * scale; const height = embedded.height * scale;
    const left = rect[0] + (rect[2] - width) / 2; const bottom = rect[1] + (rect[3] + height) / 2;
    const [x, y] = visibleToUser(geometry, left, bottom);
    page.drawImage(embedded, { x, y, width: width / geometry.unit, height: height / geometry.unit, rotate: degrees(geometry.rotation) });
  };
  let textCache: PdfTextItem[][] | undefined;
  const currentTexts = async () => textCache ??= await text.pages(await working.doc.save({ updateFieldAppearances: false }));

  for (const operation of operations) {
    check();
    if (operation.op !== 'add_highlight') textCache = undefined;
    const fact: PdfEditOperationFact = { op: operation.op, pages: [], result: 'applied' };
    switch (operation.op) {
      case 'merge': throw new PdfEditFailure('invalid-pdf-edits');
      case 'extract_pages': {
        const pages = select(operation.pages);
        if (formsAllowedAcrossCopy(working.doc)) working.pages.forEach(state => { state.prefixOnly = true; });
        await rebuild(pages.map(page => ({ doc: working.doc, index: page - 1, state: working.pages[page - 1] })), working.doc);
        fact.pages = pages; break;
      }
      case 'delete_pages': {
        const pages = select(operation.pages);
        if (pages.length >= working.doc.getPageCount()) throw new PdfEditFailure('invalid-pages');
        const all = working.doc.getPages(); const doomed = new Set(pages.map(page => page - 1));
        const removed = cleanupForDeletedPages(working.doc, all.filter((_page, index) => doomed.has(index)), all.filter((_page, index) => !doomed.has(index)));
        facts.removed.fields.push(...removed.fields); facts.removed.widgets += removed.widgets; facts.removed.links += removed.links;
        facts.removed.outline_items.push(...removed.outline_items); facts.removed.outline_destinations.push(...removed.outline_destinations);
        for (const index of [...doomed].sort((a, b) => b - a)) { working.doc.removePage(index); working.pages.splice(index, 1); }
        fact.pages = pages; break;
      }
      case 'rotate_pages': {
        const pages = select(operation.pages);
        for (const number of pages) {
          const page = working.doc.getPage(number - 1); const next = (visibleGeometry(page).rotation + operation.degrees) % 360;
          page.setRotation(degrees(next)); working.pages[number - 1].rotation = next;
        }
        fact.pages = pages; fact.detail = `${operation.degrees} degrees clockwise`; break;
      }
      case 'reorder_pages': {
        const count = working.doc.getPageCount();
        if (operation.order.length !== count || new Set(operation.order).size !== count || operation.order.some(page => page > count)) throw new PdfEditFailure('invalid-pages');
        const pages = working.doc.getPages(); pages.forEach(materializeInherited);
        for (let index = count - 1; index >= 0; index--) working.doc.removePage(index);
        operation.order.forEach((page, index) => working.doc.insertPage(index, pages[page - 1]));
        working.pages = operation.order.map(page => working.pages[page - 1]);
        fact.pages = [...operation.order]; break;
      }
      case 'replace_pages': {
        // One ascending contiguous range of the working document; a descending or out-of-range one is refused.
        const range = select(operation.pages); const first = range[0]; const last = range[range.length - 1];
        if (range.some((page, index) => page !== first + index)) throw new PdfEditFailure('invalid-pages');
        const from = loaded[operation.from.source];
        const fromPages = select(operation.from.pages, from.getPageCount());
        if (formsAllowedAcrossCopy(working.doc)) working.pages.forEach(state => { state.prefixOnly = true; });
        formsAllowedAcrossCopy(from, operation.from.source);
        documentLevelStructures(from).forEach(item => working.dropped.add(item));
        const before = working.doc.getPages().map((_page, index) => ({ doc: working.doc, index, state: working.pages[index] }));
        const replacement = fromPages.map(page => ({ doc: from, index: page - 1,
          state: { ...fresh0(operation.from.source, page), prefixOnly: facts.forms.flattened_inputs.includes(operation.from.source) } }));
        await rebuild([...before.slice(0, first - 1), ...replacement, ...before.slice(last)], working.doc);
        fact.pages = fromPages.map((_page, index) => first + index); fact.detail = `pages ${first}-${last} replaced by ${fromPages.length} source pages`; break;
      }
      case 'add_watermark': {
        const pages = select(operation.pages);
        for (const number of pages) {
          const page = working.doc.getPage(number - 1); const geometry = visibleGeometry(page);
          const { width, ascent, descent } = await measure(operation.text, operation.size);
          const radians = operation.angle * Math.PI / 180; const middle = (ascent + descent) / 2;
          const origin: [number, number] = [geometry.width / 2 - (width / 2) * Math.cos(radians) + middle * Math.sin(radians),
            geometry.height / 2 - (width / 2) * Math.sin(radians) - middle * Math.cos(radians)];
          await drawText(page, operation.text, operation.size, origin, operation.angle, rgb(operation.color), operation.opacity);
          working.pages[number - 1].overlays.push(operation.text);
        }
        fact.pages = pages; break;
      }
      case 'add_page_numbers': {
        const pages = select(operation.pages);
        for (const [ordinal, number] of pages.entries()) {
          const label = operation.format.replace(/\{n\}/g, String(operation.start + ordinal)).replace(/\{total\}/g, String(operation.start + pages.length - 1));
          const page = working.doc.getPage(number - 1); const geometry = visibleGeometry(page); const margin = 24;
          const { width } = await measure(label, operation.size);
          const x = horizontal(operation.position, geometry.width, width, margin);
          const y = operation.position.startsWith('top') ? geometry.height - margin - operation.size : margin;
          await drawText(page, label, operation.size, [x, y], 0, [0, 0, 0]);
          working.pages[number - 1].overlays.push(label);
        }
        fact.pages = pages; break;
      }
      case 'fill_form': {
        if (!hasFormFields(working.doc)) throw new PdfEditFailure('form-field-mismatch', { location: 'fields', issue: 'This PDF has no form fields.' });
        const form = working.doc.getForm(); const textFields: PDFField[] = []; const otherFields: PDFField[] = [];
        for (const [name, value] of Object.entries(operation.fields)) {
          const field = form.getFieldMaybe(name);
          const mismatch = (issue: string): never => { throw new PdfEditFailure('form-field-mismatch', { location: name, issue }); };
          if (!field) mismatch('No field has this exact name.');
          if (field!.isReadOnly()) mismatch('This field is read-only.');
          try {
            if (field instanceof PDFTextField) { if (typeof value !== 'string') mismatch('A text field takes a string.'); field.setText(value as string); textFields.push(field); }
            else if (field instanceof PDFCheckBox) { if (typeof value !== 'boolean') mismatch('A check box takes true or false.'); if (value) field.check(); else field.uncheck(); otherFields.push(field); }
            else if (field instanceof PDFRadioGroup) { if (typeof value !== 'string' || !field.getOptions().includes(value)) mismatch(`Use one of: ${field.getOptions().join(', ')}.`); field.select(value as string); otherFields.push(field); }
            else if (field instanceof PDFDropdown) {
              const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : mismatch('A choice field takes a string.');
              if (!field.isEditable() && values.some(item => !field.getOptions().includes(item))) mismatch(`Use one of: ${field.getOptions().join(', ')}.`);
              if (values.length > 1 && !field.isMultiselect()) mismatch('This choice field takes one value.');
              field.select(values); textFields.push(field);
            } else if (field instanceof PDFOptionList) {
              const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : mismatch('A list field takes a string or string array.');
              if (values.some(item => !field.getOptions().includes(item))) mismatch(`Use one of: ${field.getOptions().join(', ')}.`);
              if (values.length > 1 && !field.isMultiselect()) mismatch('This list field takes one value.');
              field.select(values); textFields.push(field);
            } else if (field instanceof PDFButton || field instanceof PDFSignature) mismatch('Push buttons and signature fields cannot be filled.');
            else mismatch('This field type is not supported.');
          } catch (error) { if (error instanceof PdfEditFailure) throw error; mismatch('The value does not fit this field.'); }
          facts.forms.filled.push(name);
        }
        const fontText = formFontText(operation.fields);
        if (textFields.length && !fontText) {
          // Only empty values: the appearances draw no glyph, so no installed font is needed (and none was read).
          const empty = form.getDefaultFont();
          for (const field of textFields) (field as PDFTextField).updateAppearances(empty);
        } else if (textFields.length) {
          const use = await font(pdfTextLanguage(fontText));
          for (const value of Object.values(operation.fields)) for (const item of typeof value === 'string' ? [value] : Array.isArray(value) ? value : []) {
            for (const line of item.split(/\r\n|\r|\n/)) if (line) shape(use, line);
          }
          for (const field of textFields) (field as PDFTextField).updateAppearances(use.embedded);
        }
        for (const field of otherFields) (field as PDFCheckBox).updateAppearances();
        if (operation.flatten) {
          try { form.flatten({ updateFieldAppearances: false }); } catch { throw new PdfEditFailure('pdf-form-flatten-failed'); }
          facts.forms.flattened = true; working.pages.forEach(state => { state.prefixOnly = true; });
        }
        fact.pages = []; fact.detail = `${Object.keys(operation.fields).length} fields${operation.flatten ? ', flattened' : ''}`; break;
      }
      case 'add_text': {
        const page = onePage(operation.page); const geometry = visibleGeometry(page); const lines = operation.text.split('\n');
        let top = operation.y;
        for (const line of lines) {
          if (line.trim()) {
            const { width, ascent } = await measure(line, operation.size);
            if (operation.x + width > geometry.width + 1e-6 || top + operation.size > geometry.height + 1e-6) throw new PdfEditFailure('invalid-pdf-edits', { location: 'add_text', issue: `The text runs outside the visible page (${round(geometry.width)} x ${round(geometry.height)} pt).` });
            await drawText(page, line, operation.size, [operation.x, geometry.height - top - ascent], 0, rgb(operation.color));
            working.pages[operation.page - 1].overlays.push(line);
          }
          top += operation.size * 1.2;
        }
        fact.pages = [operation.page]; break;
      }
      case 'add_image': {
        const page = onePage(operation.page); insideVisible(page, operation.rect, 'add_image.rect');
        const image = input.images?.[operation.image]; if (!image || sha256(image.bytes) !== image.sha256) throw new PdfEditFailure('image-unavailable');
        await drawImageIn(page, image, operation.rect); working.pages[operation.page - 1].images++;
        working.pages[operation.page - 1].facts.images.push(facts.images.length);
        facts.images.push({ page: operation.page, sha256: image.sha256, rect: operation.rect });
        fact.pages = [operation.page]; break;
      }
      case 'add_note': {
        const page = onePage(operation.page); const geometry = visibleGeometry(page); const rect: PdfRect = [operation.x, operation.y, 20, 20];
        insideVisible(page, rect, 'add_note');
        addAnnotation(page, { Subtype: 'Text', Rect: boundsOf([visibleQuad(geometry, rect)]), Contents: PDFHexString.fromText(operation.text), Name: 'Comment', Open: false });
        working.pages[operation.page - 1].annotations.push('Text'); working.pages[operation.page - 1].facts.annotations.push(facts.annotations.length);
        facts.annotations.push({ op: 'add_note', page: operation.page, subtype: 'Text', quads: 0 });
        fact.pages = [operation.page]; break;
      }
      case 'add_highlight': {
        const page = onePage(operation.page); const geometry = visibleGeometry(page); let quads: number[][]; let granularity: 'text-item' | 'rect';
        if (operation.rect) { insideVisible(page, operation.rect, 'add_highlight.rect'); quads = [visibleQuad(geometry, operation.rect)]; granularity = 'rect'; }
        else {
          quads = highlightQuads((await currentTexts())[operation.page - 1], operation.find!, operation.occurrence); granularity = 'text-item';
        }
        const bounds = boundsOf(quads); const color = rgb(operation.color);
        const path = quads.map(quad => `${n(quad[0])} ${n(quad[1])} m ${n(quad[2])} ${n(quad[3])} l ${n(quad[6])} ${n(quad[7])} l ${n(quad[4])} ${n(quad[5])} l h f`).join('\n');
        const state = working.doc.context.obj({ Type: 'ExtGState', BM: 'Multiply', ca: 0.5 });
        const appearance = working.doc.context.register(working.doc.context.stream(`/UnodeHL gs ${color.map(n).join(' ')} rg\n${path}`,
          { Type: 'XObject', Subtype: 'Form', BBox: bounds, Resources: { ExtGState: { UnodeHL: state } } } as any));
        addAnnotation(page, { Subtype: 'Highlight', Rect: bounds, QuadPoints: quads.flat(), C: color, CA: 0.5, AP: { N: appearance } });
        working.pages[operation.page - 1].annotations.push('Highlight');
        working.pages[operation.page - 1].facts.annotations.push(facts.annotations.length);
        facts.annotations.push({ op: 'add_highlight', page: operation.page, subtype: 'Highlight', quads: quads.length, granularity });
        fact.pages = [operation.page]; fact.detail = granularity === 'rect' ? 'rectangle' : `${quads.length} line(s), text-item granularity`; break;
      }
    }
    facts.operations.push(fact);
  }
  for (const signature of input.signatures ?? []) {
    check();
    const page = onePage(signature.page); insideVisible(page, signature.rect, 'place_signature.rect');
    if (sha256(signature.image.bytes) !== signature.image.sha256) throw new PdfEditFailure('image-unavailable');
    await drawImageIn(page, signature.image, signature.rect); working.pages[signature.page - 1].images++;
    facts.signatures.push({ page: signature.page, rect: signature.rect, sha256: signature.image.sha256 });
  }
  check();
  const bytes = await working.doc.save({ updateFieldAppearances: false });
  check();
  facts.dropped = [...working.dropped].sort();
  // Read-back: reopen the actual output bytes; compare pages, boxes, fields and text against the sources.
  const output = await PDFDocument.load(bytes, { updateMetadata: false });
  if (output.getPageCount() !== working.pages.length || output.getPageCount() < 1) throw new PdfEditFailure('pdf-output-check-failed');
  let outputTexts: PdfTextItem[][];
  try { outputTexts = await text.pages(bytes); } catch { throw new PdfEditFailure('pdf-output-check-failed'); }
  if (outputTexts.length !== working.pages.length) throw new PdfEditFailure('pdf-output-check-failed');
  output.getPages().forEach((page, index) => {
    const state = working.pages[index]; const expected = sourceBoxes[state.source][state.page - 1];
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray); const mediaBox = normalizedBox(page.getMediaBox());
    const found = new Map<string, number>();
    for (let at = 0; annots && at < annots.size(); at++) {
      const annotation = annots.lookupMaybe(at, PDFDict); const subtype = annotation?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
      const rect = annotation?.lookupMaybe(PDFName.of('Rect'), PDFArray)?.asArray().map(value => (value as PDFNumber).asNumber?.() ?? NaN);
      if (!subtype || !rect || rect.length !== 4 || rect.some(value => !Number.isFinite(value))) continue;
      const inside = rect[0] >= mediaBox[0] - 1e-3 && rect[1] >= mediaBox[1] - 1e-3 && rect[2] <= mediaBox[2] + 1e-3 && rect[3] <= mediaBox[3] + 1e-3;
      if (inside) found.set(subtype, (found.get(subtype) ?? 0) + 1);
    }
    for (const subtype of new Set(state.annotations)) {
      if ((found.get(subtype) ?? 0) < state.annotations.filter(item => item === subtype).length) throw new PdfEditFailure('pdf-output-check-failed');
    }
    facts.checks.annotations += state.annotations.length;
    if (state.images) {
      if (imageCount(page) < state.images + expected.images) throw new PdfEditFailure('pdf-output-check-failed');
      facts.checks.images += state.images;
    }
    const same = (a: number[], b: number[]) => a.every((value, at) => Math.abs(value - b[at]) < 1e-3);
    if (!same(normalizedBox(page.getMediaBox()), expected.media) || !same(normalizedBox(page.getCropBox()), expected.crop) || visibleGeometry(page).rotation !== state.rotation) throw new PdfEditFailure('pdf-output-check-failed');
    facts.checks.page_boxes++;
    const original = sourceTexts[state.source][state.page - 1]; const actual = outputTexts[index];
    if (!state.overlays.length && !state.prefixOnly) {
      if (fingerprint(actual) !== fingerprint(original)) throw new PdfEditFailure('pdf-output-check-failed');
    } else {
      if (fingerprint(actual.slice(0, original.length)) !== fingerprint(original)) throw new PdfEditFailure('pdf-output-check-failed');
      const added = squash(actual.slice(original.length).map(item => item.str).join(''));
      let at = 0;
      for (const overlay of state.overlays) { const found = added.indexOf(squash(overlay), at); if (found < 0) throw new PdfEditFailure('pdf-output-check-failed'); at = found + squash(overlay).length; }
      if (state.overlays.length) facts.checks.overlay_pages++;
    }
    facts.checks.text_fingerprints++;
  });
  const outputFields = hasFormFields(output) ? output.getForm().getFields() : [];
  facts.forms.fields = outputFields.map(field => ({ name: field.getName(), type: fieldType(field) }));
  if (facts.forms.flattened && outputFields.length) throw new PdfEditFailure('pdf-output-check-failed');
  // Ordered operations: a later fill of the same field supersedes an earlier one; only the final value is expected.
  const fills = new Map(input.operations.flatMap(operation => operation.op === 'fill_form' ? Object.entries(operation.fields) : []));
  if (!facts.forms.flattened) for (const [name, value] of fills) {
    const field = outputFields.find(item => item.getName() === name);
    const actual = field instanceof PDFTextField ? field.getText() ?? '' : field instanceof PDFCheckBox ? field.isChecked()
      : field instanceof PDFRadioGroup ? field.getSelected() : field instanceof PDFDropdown || field instanceof PDFOptionList ? field.getSelected() : undefined;
    const wanted = Array.isArray(value) ? value : (field instanceof PDFDropdown || field instanceof PDFOptionList) && typeof value === 'string' ? [value] : value;
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new PdfEditFailure('pdf-output-check-failed');
    facts.checks.field_values++;
  }
  if (working.inPlace && !facts.forms.flattened) {
    const original = await PDFDocument.load(input.sources[0].bytes, { updateMetadata: false });
    const before = hasFormFields(original) ? original.getForm().getFields().map(field => `${field.getName()}:${fieldType(field)}`) : [];
    const expected = before.filter(entry => !facts.removed.fields.includes(entry.slice(0, entry.lastIndexOf(':')))).sort();
    if (JSON.stringify(expected) !== JSON.stringify(facts.forms.fields.map(field => `${field.name}:${field.type}`).sort())) throw new PdfEditFailure('pdf-output-check-failed');
  }
  facts.page_map = working.pages.map(state => ({ source: state.source, page: state.page, rotated: (state.rotation - sourceBoxes[state.source][state.page - 1].rotation + 360) % 360 }));
  working.pages.forEach((state, index) => {
    for (const at of state.facts.annotations) facts.annotations[at].output_page = index + 1;
    for (const at of state.facts.images) facts.images[at].output_page = index + 1;
  });
  facts.page_text_head = outputTexts.map(items => items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim().slice(0, 160));
  facts.page_identity = output.getPages().map(page => {
    const geometry = visibleGeometry(page);
    return { ref: `${page.ref.objectNumber} ${page.ref.generationNumber}`, content_sha256: pageContentSha256(page), width: geometry.width, height: geometry.height, rotation: geometry.rotation };
  });
  facts.pages = output.getPageCount(); facts.sha256 = sha256(bytes);
  return { ...facts, bytes };
}

const round = (value: number) => Math.round(value * 10) / 10;
const n = (value: number) => Number(value.toFixed(3)).toString();

/** Image XObjects named in a page's own resources. */
function imageCount(page: PDFPage): number {
  const resources = page.node.Resources(); const objects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  return objects ? objects.keys().filter(key => objects.lookupMaybe(key, PDFStream)?.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() === 'Image').length : 0;
}

/** SHA-256 of a page's stored content-stream bytes, in order. */
export function pageContentSha256(page: PDFPage): string {
  const hash = createHash('sha256'); const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  for (const entry of streams) {
    const stream = entry instanceof PDFRef ? page.doc.context.lookup(entry) : entry;
    if (stream instanceof PDFRawStream) hash.update(stream.contents);
  }
  return hash.digest('hex');
}

/**
 * 13.12 highlight geometry: a literal NFC match in the page's joined PDF.js item text; every item the match touches is
 * highlighted whole (text-item granularity), one quad per line.
 */
export function highlightQuads(items: PdfTextItem[], find: string, occurrence: number): number[][] {
  const owners: number[] = []; let joined = '';
  items.forEach((item, index) => { const value = item.str.normalize('NFC'); joined += value; for (let at = 0; at < value.length; at++) owners.push(index); });
  const needle = find.normalize('NFC'); let start = -1;
  for (let count = 0, from = 0; count < occurrence; count++) { start = joined.indexOf(needle, from); if (start < 0) break; from = start + 1; }
  if (start < 0 || !needle) throw new PdfEditFailure('text-not-found');
  const touched = [...new Set(owners.slice(start, start + needle.length))].map(index => items[index]).filter(item => item.width > 0);
  if (!touched.length) throw new PdfEditFailure('text-not-found');
  const lines: PdfTextItem[][] = [];
  for (const item of touched) {
    const line = lines.find(group => Math.abs(group[0].transform[5] - item.transform[5]) < Math.max(1, (group[0].height || 1) * 0.5)
      && Math.abs(group[0].transform[1] - item.transform[1]) < 1e-6 && Math.abs(group[0].transform[0] - item.transform[0]) < 1e-6);
    if (line) line.push(item); else lines.push([item]);
  }
  return lines.map(line => {
    const [a, b, c, d, e, f] = line[0].transform; const along = Math.hypot(a, b) || 1;
    const dir = [a / along, b / along]; const upLength = Math.hypot(c, d); const up = upLength ? [c / upLength, d / upLength] : [-dir[1], dir[0]];
    let s0 = Infinity; let s1 = -Infinity; let t0 = Infinity; let t1 = -Infinity;
    for (const item of line) {
      const dx = item.transform[4] - e; const dy = item.transform[5] - f; const height = item.height || upLength || 1;
      const s = dx * dir[0] + dy * dir[1]; const t = dx * up[0] + dy * up[1];
      s0 = Math.min(s0, s); s1 = Math.max(s1, s + item.width); t0 = Math.min(t0, t - height * 0.25); t1 = Math.max(t1, t + height);
    }
    const at = (s: number, t: number) => [e + dir[0] * s + up[0] * t, f + dir[1] * s + up[1] * t];
    return [...at(s0, t1), ...at(s1, t1), ...at(s0, t0), ...at(s1, t0)];
  });
}

function horizontal(position: PageNumberPosition, pageWidth: number, width: number, margin: number): number {
  return position.endsWith('left') ? margin : position.endsWith('right') ? pageWidth - margin - width : (pageWidth - width) / 2;
}
function fieldType(field: PDFField): string {
  return field instanceof PDFTextField ? 'text' : field instanceof PDFCheckBox ? 'checkbox' : field instanceof PDFRadioGroup ? 'radio'
    : field instanceof PDFDropdown ? 'dropdown' : field instanceof PDFOptionList ? 'list' : field instanceof PDFButton ? 'button' : field instanceof PDFSignature ? 'signature' : 'unknown';
}
