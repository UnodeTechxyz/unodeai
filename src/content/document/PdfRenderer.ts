import { createHash } from 'node:crypto';
import * as pdf from 'pdf-lib';
import { DocumentFailure, documentPlainText,
  type CanonicalDocumentRequest, type DocumentRenderStats, type DocumentText } from './DocumentContracts';
import { admitDocumentLayout, admitDocumentText } from './DocumentLayoutAdmission';
import { selectDocumentFontFace } from './FontFaceSelection';
import { bindSubsetPdfFontAdapter, positionedPdfGlyphs } from './PdfFontAdapter';

export interface PdfFontSource { bytes: ArrayBuffer; sha256: string; family: string }
export type PdfFontReader = (language: string, style: 'regular' | 'bold') => Promise<PdfFontSource[]>;
interface Use {
  resource: string; embedded: pdf.PDFFont; adapter: ReturnType<typeof bindSubsetPdfFontAdapter>;
  units: number; ascent: number; descent: number;
}
interface Atom { text: string; use: Use; width: number }
interface Line { atoms: Atom[]; width: number; height: number; ascent: number; size: number }
interface Placed { line: Line; x: number; top: number }
interface Border { x: number; top: number; width: number; height: number }
interface Page { lines: Placed[]; borders: Border[] }
const noStart = new Set([... '，。！？；：、）》】」』']);
const noEnd = new Set([... '（《【「『']);
const scriptFor = (language: string) => /^ko(?:-|$)/.test(language) ? ['hang', 'KOR']
  : /^ja(?:-|$)/.test(language) ? ['hani', 'JAN'] : /^zh-Hans(?:-|$)/.test(language) ? ['hani', 'ZHS']
    : /^zh-Hant(?:-|$)/.test(language) ? ['hani', 'ZHT'] : ['latn', /^fr(?:-|$)/.test(language) ? 'FRA' : /^es(?:-|$)/.test(language) ? 'ESP' : 'ENG'];

/** Two-pass integer-twip layout and public PDF operators only. No paths, writes or native code. */
export async function renderPdf(request: CanonicalDocumentRequest, readFonts: PdfFontReader) {
  const admitted = admitDocumentLayout(request.document);
  const issue = admitted.fields.flatMap(field => field.issues)[0];
  if (issue) throw new DocumentFailure(issue.code);
  const fontkit = require('fontkit') as import('./FontFaceSelection').PublicFontkit;
  const document = await pdf.PDFDocument.create({ updateMetadata: false });
  document.setCreationDate(new Date('2000-01-01T00:00:00Z')); document.setModificationDate(new Date('2000-01-01T00:00:00Z'));
  document.setCreator('UnodeAi'); document.setProducer('UnodeAi document renderer 2'); document.setTitle(documentPlainText(request.document.title));
  const uses = new Map<string, Use>(); const manifest: object[] = [];
  const loadFont = async (language: string, bold: boolean) => {
    const key = `${language}/${bold}`; const cached = uses.get(key); if (cached) return cached;
    if (uses.size >= 32) throw new DocumentFailure('font-budget');
    const style = bold ? 'bold' : 'regular'; const sources = await readFonts(language, style);
    let selected: { face: any; metadata: ReturnType<typeof selectDocumentFontFace>['metadata']; source: PdfFontSource } | undefined;
    for (const source of sources) {
      if (createHash('sha256').update(new Uint8Array(source.bytes)).digest('hex') !== source.sha256) throw new DocumentFailure('font-resource-changed');
      try { selected = { ...selectDocumentFontFace(fontkit, new Uint8Array(source.bytes), { family: source.family, style }), source }; break; }
      catch (error) { if (!(error instanceof DocumentFailure) || error.code !== 'font-unavailable') throw error; }
    }
    if (!selected) throw new DocumentFailure('font-unavailable');
    const { face, metadata, source } = selected; const [script, otLanguage] = scriptFor(language);
    const adapter = bindSubsetPdfFontAdapter(face, new Uint8Array(source.bytes), metadata, script, otLanguage);
    document.registerFontkit(adapter.fontkit as any);
    const resource = `DF${uses.size}`; const embedded = await document.embedFont(source.bytes, { subset: true, customName: resource });
    const use = { resource, embedded, adapter, units: face.unitsPerEm, ascent: face.ascent, descent: face.descent };
    if (![use.units, use.ascent, use.descent].every(Number.isFinite) || use.units <= 0) throw new DocumentFailure('font-resource-invalid');
    uses.set(key, use); manifest.push({ language, style, script, sha256: source.sha256, faceIndex: metadata.faceIndex,
      postscriptName: face.postscriptName, weightClass: metadata.weightClass, fsType: metadata.fsType, outlines: metadata.outlines });
    return use;
  };
  // A table can wrap several new language/style cells concurrently. Deduplicate their bindings and
  // keep the broker's one-read-in-flight contract without depending on filesystem completion order.
  const fontJobs = new Map<string, Promise<Use>>(); let fontTail: Promise<void> = Promise.resolve(); let fontFailure: unknown;
  const fonts = (language: string, bold: boolean): Promise<Use> => {
    const key = `${language}/${bold}`; const cached = uses.get(key); if (cached) return Promise.resolve(cached);
    const previous = fontJobs.get(key); if (previous) return previous;
const pending = fontTail.then(() => { if (fontFailure) throw fontFailure; return loadFont(language, bold); });
    fontJobs.set(key, pending); fontTail = pending.then(() => undefined, error => { fontFailure = error; }); return pending;
  };
  const width = request.document.page === 'a4' ? 11906 : 12240;
  const height = request.document.page === 'a4' ? 16838 : 15840;
  const margin = 1440; const bodyWidth = width - margin * 2;
  const wrapText = async (text: DocumentText, maxWidth: number, size = 10.5, forceBold = false): Promise<Line[]> => {
    const admission = admitDocumentText(text); if (admission.issues.length) throw new DocumentFailure(admission.issues[0].code);
    const atoms: Atom[] = [];
    for (const cluster of admission.clusters) {
      const use = await fonts(cluster.language, forceBold || cluster.bold);
      const shaped = cluster.text === '\n' ? undefined : use.adapter.layout(cluster.text);
      const advance = shaped?.positions.reduce((n, position) => n + position.xAdvance, 0) ?? 0;
      atoms.push({ text: cluster.text, use, width: Math.round(advance * size * 20 / use.units) });
    }
    const lines: Line[] = []; let start = 0;
    const line = (parts: Atom[]): Line => {
      const ascent = Math.max(Math.ceil(size * 16), ...parts.map(a => Math.ceil(a.use.ascent * size * 20 / a.use.units)));
      const descent = Math.max(0, ...parts.map(a => Math.ceil(-a.use.descent * size * 20 / a.use.units)));
      return { atoms: parts, width: parts.reduce((n, a) => n + a.width, 0), size, ascent, height: Math.max(300, ascent + descent) };
    };
    while (start < atoms.length) {
      if (atoms[start].text === '\n') { lines.push(line([])); start++; continue; }
      let end = start; let used = 0; let wordBreak = -1;
      while (end < atoms.length && atoms[end].text !== '\n' && used + atoms[end].width <= maxWidth) {
        used += atoms[end].width; if (/^\s$/.test(atoms[end].text)) wordBreak = end + 1; end++;
      }
      if (end === start) throw new DocumentFailure('layout-unrepresentable');
      if (end < atoms.length && atoms[end].text !== '\n' && wordBreak > start) end = wordBreak;
      const greedy = end;
      while (end > start && (noEnd.has(atoms[end - 1].text) || end < atoms.length && noStart.has(atoms[end].text))) end--;
      // v0.9.99: a run of punctuation longer than a line cannot honour the line-start/line-end rules anywhere;
      // break it where the line is full rather than refuse the document.
      if (end === start) end = greedy;
      lines.push(line(atoms.slice(start, end))); start = end;
      if (atoms[start]?.text === '\n') start++;
    }
    return lines.length ? lines : [line([])];
  };
  // v0.9.99: a layout may run more than once (footer reservation from the real page count), so each field is
  // shaped and wrapped once per width, size and weight. Lines are never mutated after wrapping.
  const wrapped = new WeakMap<DocumentText, Map<string, Promise<Line[]>>>();
  const wrap = (text: DocumentText, maxWidth: number, size = 10.5, forceBold = false): Promise<Line[]> => {
    let shapes = wrapped.get(text);
    if (!shapes) { shapes = new Map(); wrapped.set(text, shapes); }
    const key = `${maxWidth}/${size}/${forceBold}`; let lines = shapes.get(key);
    if (!lines) { lines = wrapText(text, maxWidth, size, forceBold); shapes.set(key, lines); }
    return lines;
  };
  const headers = request.document.header ? await wrap(request.document.header, bodyWidth, 9) : [];
  const headerHeight = headers.reduce((sum, line) => sum + line.height, 0);
  const bodyTop = Math.max(margin, 480 + headerHeight + 240);
  const footerFor = (page: number, total: number) => wrap([...(request.document.footer ?? []),
    { text: ` ${page} / ${total}`, bold: false, language: request.document.language }], bodyWidth, 9);
  // How far a footer reaches above its last line's top; the body stops 240 twips above the footer's first line.
  const reach = (lines: Line[]) => lines.reduce((sum, line) => sum + line.height, 0) - lines.at(-1)!.height;

  /** v0.9.99: one pass of body layout for a given body bottom. No page or line ceiling: the document paginates. */
  const layout = async (bottom: number): Promise<Page[]> => {
    const body = bottom - bodyTop;
    if (body <= 0) throw new DocumentFailure('layout-unrepresentable');
    const pages: Page[] = []; let page!: Page; let y = bodyTop;
    const newPage = () => { page = { lines: [], borders: [] }; pages.push(page); y = bodyTop; };
    // Keep a group on one page when it fits on one. A group taller than a whole page starts on a fresh page and
    // flows across pages instead of failing; only a single line that no empty page can hold is unrepresentable.
    const keep = (space: number) => { if (y + space > bottom && y > bodyTop) newPage(); };
    const place = (line: Line, x: number, top: number) => {
      if (x < margin || x + line.width > width - margin + 1 || top < bodyTop || top + line.height > bottom + 1) throw new DocumentFailure('layout-unrepresentable');
      page.lines.push({ line, x, top });
    };
    const paragraph = (lines: Line[], x = margin) => {
      for (let i = 0; i < lines.length; i++) {
        const remaining = lines.length - i;
        keep(lines.slice(i, i + Math.min(2, remaining)).reduce((n, l) => n + l.height, 0));
        place(lines[i], x, y); y += lines[i].height;
      }
      y += 120;
    };
    newPage();
    const title = await wrap(request.document.title, bodyWidth, 20);
    for (const line of title) { keep(line.height); place(line, request.template === 'contract-v1' ? margin + Math.floor((bodyWidth - line.width) / 2) : margin, y); y += line.height; } y += 240;
    if (request.document.subtitle) paragraph(await wrap(request.document.subtitle, bodyWidth));
    for (let index = 0; index < request.document.blocks.length; index++) {
      const block = request.document.blocks[index];
      if (block.type === 'page-break') { newPage(); continue; }
      if (block.type === 'paragraph') paragraph(await wrap(block.content, bodyWidth));
      if (block.type === 'heading') {
        const lines = await wrap(block.content, bodyWidth, [16, 13, 11.5][block.level - 1], true);
        const next = request.document.blocks[index + 1];
        const following = next && (next.type === 'paragraph' || next.type === 'clause') ? await wrap(next.content, next.type === 'clause' ? bodyWidth - 720 : bodyWidth) : [];
        let followingHeight = following.slice(0, 2).reduce((n, line) => n + line.height, 0);
        if (next?.type === 'table') {
          const cellWidth = Math.floor(bodyWidth / next.headers.length) - 160;
          const headers = await Promise.all(next.headers.map(cell => wrap(cell, cellWidth, 10.5, true)));
          const firstRow = await Promise.all(next.rows[0].map(cell => wrap(cell, cellWidth)));
          followingHeight = Math.max(...headers.map(value => value.reduce((n, line) => n + line.height, 0)))
            + Math.max(...firstRow.map(value => value[0].height)) + 320;
        } else if (next?.type === 'signature') followingHeight = 1440;
        const before = request.template === 'contract-v1' ? 360 : 240;
        keep(before + lines.reduce((n, l) => n + l.height, 0) + 120 + followingHeight);
        y += before;
        paragraph(lines);
      }
      if (block.type === 'clause') {
        const label = await wrap(block.label, 720); const content = await wrap(block.content, bodyWidth - 720);
        const labelHeight = label.reduce((n, l) => n + l.height, 0);
        if (labelHeight > body / 2) {
          // A label too long for its narrow column reflows above the clause text at full width.
          paragraph(await wrap(block.label, bodyWidth)); paragraph(content, margin + 720);
        } else {
          keep(Math.max(labelHeight, content.slice(0, 2).reduce((n, l) => n + l.height, 0)));
          const start = y; const labelPage = pages.length; let ly = start; for (const line of label) { place(line, margin, ly); ly += line.height; }
          paragraph(content, margin + 720); if (pages.length === labelPage) y = Math.max(y, ly + 120);
        }
      }
      if (block.type === 'table') {
        const cellWidth = Math.floor(bodyWidth / block.headers.length); const pad = 80;
        const headers = await Promise.all(block.headers.map(cell => wrap(cell, cellWidth - pad * 2, 10.5, true)));
        const headerHeight = Math.max(...headers.map(lines => lines.reduce((n, l) => n + l.height, 0))) + pad * 2;
        // A header row up to a third of the page repeats on every page of the table; a taller one flows once.
        const repeat = headerHeight <= body / 3;
        const row = (cells: Line[][], bandHeight: number) => {
          for (let c = 0; c < cells.length; c++) {
            const x = margin + c * cellWidth; let top = y + pad;
            page.borders.push({ x, top: y, width: cellWidth, height: bandHeight });
            for (const line of cells[c]) { place(line, x + pad, top); top += line.height; }
          } y += bandHeight;
        };
        const header = () => { if (repeat) row(headers, headerHeight); };
        const flow = (lines: Line[][]) => {
          let band = 0; let fresh = false; const total = Math.max(...lines.map(value => value.length));
          while (band < total) {
            const heights = Array.from({ length: total - band }, (_, i) => Math.max(300, ...lines.map(value => value[band + i]?.height ?? 0)));
            let count = 0; let rowHeight = pad * 2;
            while (count < heights.length && y + rowHeight + heights[count] <= bottom) rowHeight += heights[count++];
            if (!count) {
              // Not even one line of this row fits on a page that holds nothing else of it: truly unrepresentable.
              if (fresh) throw new DocumentFailure('layout-unrepresentable', index);
              newPage(); header(); fresh = true; continue;
            }
            // Equal-height line bands keep every column aligned even when fonts have different metrics.
            const sliced = lines.map(value => value.slice(band, band + count).map((line, i) => ({ ...line, height: heights[i] })));
            row(sliced, rowHeight); band += count; fresh = false;
            if (band < total) { newPage(); header(); fresh = true; }
          }
        };
        if (repeat) { keep(headerHeight + 460); header(); } else { keep(headerHeight); flow(headers); }
        for (const cells of block.rows) flow(await Promise.all(cells.map(cell => wrap(cell, cellWidth - pad * 2))));
        y += 120;
      }
      if (block.type === 'signature') {
        for (let i = 0; i < block.parties.length; i += 2) {
          const parties = block.parties.slice(i, i + 2); const slot = Math.floor(bodyWidth / parties.length);
          const lines = await Promise.all(parties.map(async party => [...await wrap(party.label, slot - 160, 10.5, true),
            ...await wrap(party.name ?? [{ text: '____________________', bold: false, language: request.document.language }], slot - 160)]));
          const space = Math.max(1440, ...lines.map(value => value.reduce((n, line) => n + line.height, 0)));
          if (space > body) {
            // Signature text longer than a page flows party by party instead of side by side.
            for (const value of lines) paragraph(value);
          } else {
            keep(space); for (let c = 0; c < lines.length; c++) { let top = y;
              for (const line of lines[c]) { place(line, margin + c * slot, top); top += line.height; } } y += space;
          }
        }
      }
    }
    return pages;
  };

  // v0.9.99: the footer reservation comes from the actual page count. Lay out, wrap every page's real footer, and
  // lay out again only if a footer reaches higher than the space reserved (more digits can wrap a long footer).
  let reserved = reach(await footerFor(1, 1));
  let pages: Page[] = []; let footers: Line[][] = [];
  for (let attempt = 0; ; attempt++) {
    pages = await layout(Math.min(height - margin, height - 960 - reserved - 240));
    footers = [];
    for (let i = 0; i < pages.length; i++) footers.push(await footerFor(i + 1, pages.length));
    const needed = Math.max(...footers.map(reach));
    if (needed <= reserved) break;
    // Each pass reserves at least as much as the last, so this settles within a few digit counts.
    if (attempt >= 8) throw new DocumentFailure('layout-unrepresentable');
    reserved = needed;
  }
  // Template fields are prepared before drawing; no font binding changes during the second pass.
  const draw = (target: pdf.PDFPage, placed: Placed) => {
    let x = placed.x / 20; const size = placed.line.size;
    for (const atom of placed.line.atoms) {
      const use = atom.use; const run = use.adapter.layout(atom.text);
      target.node.setFontDictionary(pdf.PDFName.of(use.resource), use.embedded.ref);
      const baseline = (height - placed.top - placed.line.ascent) / 20;
      const positions = positionedPdfGlyphs(run, use.embedded.encodeText(atom.text).asString(), use.units, size, x, baseline);
      for (const glyph of positions) target.pushOperators(pdf.beginText(), pdf.setFontAndSize(pdf.PDFName.of(use.resource), size),
        pdf.setTextMatrix(1, 0, 0, 1, glyph.x, glyph.y), pdf.showText(pdf.PDFHexString.of(glyph.cidHex)), pdf.endText());
      x += atom.width / 20;
    }
  };
  for (let i = 0; i < pages.length; i++) {
    const target = document.addPage([width / 20, height / 20]);
    for (const placed of pages[i].lines) draw(target, placed);
    for (const box of pages[i].borders) target.drawRectangle({ x: box.x / 20, y: (height - box.top - box.height) / 20,
      width: box.width / 20, height: box.height / 20, borderWidth: 0.5, borderColor: pdf.rgb(0, 0, 0) });
    let headerTop = 480;
    for (const line of headers) { draw(target, { line, x: margin, top: headerTop }); headerTop += line.height; }
    const lines = footers[i]; let footerTop = height - 960 - lines.reduce((sum, line) => sum + line.height, 0) + lines.at(-1)!.height;
    for (const line of lines) { draw(target, { line, x: margin, top: footerTop }); footerTop += line.height; }
  }
  const bytes = Buffer.from(await document.save({ useObjectStreams: false, addDefaultPage: false }));
  const stats: DocumentRenderStats = { format: 'pdf', template: request.template, blocks: request.document.blocks.length,
    headings: request.document.blocks.filter(block => block.type === 'heading').length,
    clauses: request.document.blocks.filter(block => block.type === 'clause').length, tables: request.document.blocks.filter(block => block.type === 'table').length,
    pages: document.getPageCount(), rendererRevision: 2,
    fontManifestDigest: createHash('sha256').update(JSON.stringify({ fontkit: '2.0.4', pdfLib: '1.17.1', uses: manifest })).digest('hex') };
  return { bytes, stats, fontPlan: manifest };
}
