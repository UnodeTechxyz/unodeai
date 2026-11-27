import { createHash } from 'node:crypto';
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts, degrees } from 'pdf-lib';
import { pdfTestFont } from '../../../content/document/__tests__/pdfTestFont';
import { pdfjsTextPort } from '../PdfTextLayer';
import type { PdfEngineSource } from '../PdfEditEngine';

export const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const source = (bytes: Uint8Array): PdfEngineSource => ({ bytes, sha256: sha(bytes) });
export const textPort = pdfjsTextPort(() => import('pdfjs-dist/legacy/build/pdf.mjs') as any);

/** A test-only font holding ASCII plus the given extra characters, as the host would supply it per language. */
export function testFonts(extra = '') {
  const bytes = Uint8Array.from(pdfTestFont(false, extra)).buffer;
  const entry = [{ bytes, sha256: sha(new Uint8Array(bytes)), family: 'UnodeTest' }];
  return { en: entry, 'zh-Hans': entry, ja: entry, ko: entry };
}

export interface PageSpec { text: string; size?: [number, number]; rotate?: number; crop?: [number, number, number, number]; userUnit?: number }
export async function makePdf(pages: PageSpec[], options: { title?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
  if (options.title) doc.setTitle(options.title);
  for (const spec of pages) {
    const page = doc.addPage(spec.size ?? [300, 400]);
    page.drawText(spec.text, { x: 40, y: 300, size: 14, font });
    if (spec.rotate) page.setRotation(degrees(spec.rotate));
    if (spec.crop) page.setCropBox(...spec.crop);
    if (spec.userUnit) page.node.set(PDFName.of('UserUnit'), PDFNumber.of(spec.userUnit));
  }
  return doc.save();
}

/** Text field on page 1, check box on page 2, a field with widgets on both pages, a radio group and a dropdown. */
export async function makeFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage([300, 400]); const second = doc.addPage([300, 400]);
  first.drawText('Form page one', { x: 40, y: 360, size: 12, font }); second.drawText('Form page two', { x: 40, y: 360, size: 12, font });
  const form = doc.getForm();
  form.createTextField('name').addToPage(first, { x: 40, y: 300, width: 200, height: 24 });
  form.createCheckBox('agree').addToPage(second, { x: 40, y: 300, width: 16, height: 16 });
  const shared = form.createTextField('shared'); shared.addToPage(first, { x: 40, y: 250, width: 200, height: 24 }); shared.addToPage(second, { x: 40, y: 250, width: 200, height: 24 });
  const radio = form.createRadioGroup('choice'); radio.addOptionToPage('yes', first, { x: 40, y: 200, width: 16, height: 16 }); radio.addOptionToPage('no', first, { x: 80, y: 200, width: 16, height: 16 });
  const dropdown = form.createDropdown('city'); dropdown.addOptions(['Paris', 'Rome']); dropdown.addToPage(first, { x: 40, y: 150, width: 120, height: 24 });
  form.updateFieldAppearances(font);
  return doc.save();
}

/** Outline items "Second" (page 2, leaf) and "First" (page 1), plus a link on page 1 pointing at page 2. */
export async function makeOutlinedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await makePdf([{ text: 'Outline one' }, { text: 'Outline two' }, { text: 'Outline three' }]));
  const [first, second] = doc.getPages(); const context = doc.context;
  const root = context.register(context.obj({ Type: 'Outlines' }));
  const itemA = context.nextRef(); const itemB = context.nextRef();
  context.assign(itemA, context.obj({ Title: PDFString.of('Second'), Parent: root, Next: itemB, Dest: [second.ref, 'Fit'] }));
  context.assign(itemB, context.obj({ Title: PDFString.of('First'), Parent: root, Prev: itemA, Dest: [first.ref, 'Fit'] }));
  const outlines = context.lookup(root, PDFDict); outlines.set(PDFName.of('First'), itemA); outlines.set(PDFName.of('Last'), itemB); outlines.set(PDFName.of('Count'), PDFNumber.of(2));
  doc.catalog.set(PDFName.of('Outlines'), root);
  const link = context.register(context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 50], Dest: [second.ref, 'Fit'] }));
  first.node.set(PDFName.of('Annots'), context.obj([link]));
  return doc.save();
}
