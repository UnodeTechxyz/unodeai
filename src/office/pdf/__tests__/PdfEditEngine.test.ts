import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, PDFTextField, StandardFonts } from 'pdf-lib';
import { runPdfEdit, userToVisible, visibleGeometry, type PdfEngineOperation } from '../PdfEditEngine';
import { validatePdfEditRequest } from '../PdfEditContracts';
import { makeFormPdf, makeOutlinedPdf, makePdf, sha, source, testFonts, textPort } from './pdfFixtures';

const run = (sources: Uint8Array[], operations: PdfEngineOperation[], options: { inputCount?: number; flatten?: boolean; fonts?: ReturnType<typeof testFonts> } = {}) =>
  runPdfEdit({ sources: sources.map(source), inputCount: options.inputCount ?? 1, operations, flattenFormsBeforeMerge: options.flatten ?? false, fonts: options.fonts ?? testFonts() }, textPort);
const texts = async (bytes: Uint8Array) => (await textPort.pages(bytes)).map(items => items.map(item => item.str).join(''));

describe('edit_pdf engine: page operations', () => {
  it('merges in input order, watermarks and numbers pages, and reads back fingerprints and overlays', async () => {
    const a = await makePdf([{ text: 'Contract page A1' }, { text: 'Contract page A2' }], { title: 'Contract' }); const b = await makePdf([{ text: 'Annex B1' }]);
    const result = await run([a, b], [{ op: 'merge' }, { op: 'add_watermark', text: 'DRAFT', opacity: 0.2, angle: 45, size: 48, color: '808080' },
      { op: 'add_page_numbers', format: '{n}/{total}', position: 'bottom-center', start: 1, size: 10 }], { inputCount: 2 });
    expect(result.pages).toBe(3); expect(result.page_map).toEqual([{ source: 0, page: 1, rotated: 0 }, { source: 0, page: 2, rotated: 0 }, { source: 1, page: 1, rotated: 0 }]);
    expect(result.sha256).toBe(sha(result.bytes)); expect(result.checks).toMatchObject({ page_boxes: 3, text_fingerprints: 3, overlay_pages: 3 });
    const pages = await texts(result.bytes);
    expect(pages[0]).toContain('Contract page A1'); expect(pages[0]).toContain('DRAFT'); expect(pages[0].replace(/\s/g, '')).toContain('1/3');
    expect(pages[2]).toContain('Annex B1'); expect(pages[2].replace(/\s/g, '')).toContain('3/3');
    expect((await PDFDocument.load(result.bytes)).getTitle()).toBe('Contract');
  });

  it('extracts, reorders, rotates and deletes with page-map and box read-back', async () => {
    const pdf = await makePdf([{ text: 'One' }, { text: 'Two', size: [500, 300] }, { text: 'Three' }, { text: 'Four' }]);
    const result = await run([pdf], [{ op: 'extract_pages', pages: '2-4' }, { op: 'reorder_pages', order: [3, 1, 2] }, { op: 'rotate_pages', pages: '2', degrees: 90 }, { op: 'delete_pages', pages: '3' }]);
    expect(result.page_map).toEqual([{ source: 0, page: 4, rotated: 0 }, { source: 0, page: 2, rotated: 90 }]);
    const output = await PDFDocument.load(result.bytes);
    expect(output.getPage(1).getRotation().angle).toBe(90); expect(output.getPage(1).getMediaBox()).toMatchObject({ width: 500, height: 300 });
    expect(await texts(result.bytes)).toEqual(['Four', 'Two']);
  });

  it('read-back refuses an output whose copied page text or added overlay does not match', async () => {
    const pdf = await makePdf([{ text: 'Original text' }, { text: 'Second' }]); const inputs = new Set([sha(pdf)]);
    const altered = (mutate: (pages: Awaited<ReturnType<typeof textPort.pages>>) => void) => ({ pages: async (bytes: Uint8Array) => {
      const pages = await textPort.pages(bytes); if (!inputs.has(sha(bytes))) mutate(pages); return pages;
    } });
    const engine = (port: ReturnType<typeof altered>, operations: PdfEngineOperation[]) => runPdfEdit({ sources: [source(pdf)], inputCount: 1, operations, flattenFormsBeforeMerge: false, fonts: testFonts() }, port);
    await expect(engine(altered(pages => { pages[1][0].str = 'Tampered'; }), [{ op: 'rotate_pages', pages: '1', degrees: 90 }])).rejects.toMatchObject({ message: 'pdf-output-check-failed' });
    await expect(engine(altered(pages => { for (const item of pages[0]) if (item.str.includes('DRAFT')) item.str = ''; }), [{ op: 'add_watermark', text: 'DRAFT', opacity: 0.2, angle: 0, size: 20, color: '000000' }])).rejects.toMatchObject({ message: 'pdf-output-check-failed' });
  });

  it('refuses out-of-range pages, a non-permutation order and deleting every page', async () => {
    const pdf = await makePdf([{ text: 'One' }, { text: 'Two' }]);
    await expect(run([pdf], [{ op: 'delete_pages', pages: '3' }])).rejects.toMatchObject({ message: 'invalid-pages' });
    await expect(run([pdf], [{ op: 'reorder_pages', order: [1, 1] }])).rejects.toMatchObject({ message: 'invalid-pages' });
    await expect(run([pdf], [{ op: 'delete_pages', pages: '1-2' }])).rejects.toMatchObject({ message: 'invalid-pages' });
  });

  it('places page numbers in the visible frame of rotated and cropped pages', async () => {
    const pdf = await makePdf([{ text: 'Rotated', rotate: 90 }, { text: 'Cropped', crop: [20, 30, 250, 300] }, { text: 'Upside', rotate: 270, crop: [10, 10, 290, 390] }]);
    const result = await run([pdf], [{ op: 'add_page_numbers', format: 'P{n}', position: 'bottom-center', start: 1, size: 10 }]);
    const output = await PDFDocument.load(result.bytes); const items = await textPort.pages(result.bytes);
    output.getPages().forEach((page, index) => {
      const geometry = visibleGeometry(page); const label = items[index].filter(item => /P|\d/.test(item.str)).slice(-1)[0];
      const [vx, vy] = userToVisible(geometry, label.transform[4], label.transform[5]);
      expect(vy, `page ${index + 1}`).toBeCloseTo(geometry.height - 24, 0); expect(vx).toBeGreaterThan(geometry.width / 2 - 30); expect(vx).toBeLessThan(geometry.width / 2);
    });
  });

  it('draws Chinese overlay text with the selected font, or refuses when no font has the glyphs', async () => {
    const pdf = await makePdf([{ text: 'Page' }]);
    const result = await run([pdf], [{ op: 'add_watermark', text: '草稿', opacity: 0.3, angle: 30, size: 40, color: 'ff0000' }], { fonts: testFonts('草稿') });
    expect((await texts(result.bytes))[0]).toContain('草稿'); expect(result.fonts).toEqual([expect.objectContaining({ language: 'zh-Hans', family: 'UnodeTest' })]);
    await expect(run([pdf], [{ op: 'add_watermark', text: '草稿', opacity: 0.3, angle: 30, size: 40, color: 'ff0000' }])).rejects.toMatchObject({ message: 'unsupported-glyph' });
    await expect(run([pdf], [{ op: 'add_watermark', text: 'DRAFT', opacity: 0.3, angle: 30, size: 40, color: 'ff0000' }], { fonts: {} as any })).rejects.toMatchObject({ message: 'font-unavailable' });
  });
});

describe('edit_pdf engine: forms and document structure', () => {
  it('fills fields keeping them editable, then reads the values back', async () => {
    const pdf = await makeFormPdf();
    const result = await run([pdf], [{ op: 'fill_form', fields: { name: 'Ada 名称', agree: true, choice: 'no', city: 'Rome' }, flatten: false }], { fonts: testFonts('名称') });
    const form = (await PDFDocument.load(result.bytes)).getForm();
    expect((form.getField('name') as PDFTextField).getText()).toBe('Ada 名称'); expect(form.getCheckBox('agree').isChecked()).toBe(true);
    expect(form.getRadioGroup('choice').getSelected()).toBe('no'); expect(form.getDropdown('city').getSelected()).toEqual(['Rome']);
    expect(result.forms.fields.map(field => field.name).sort()).toEqual(['agree', 'choice', 'city', 'name', 'shared']); expect(result.checks.field_values).toBe(4);
    form.getTextField('name').setText('still editable'); expect(form.getTextField('name').getText()).toBe('still editable');
  });

  it('flattens on request, and refuses unknown fields and mistyped values', async () => {
    const pdf = await makeFormPdf();
    const flat = await run([pdf], [{ op: 'fill_form', fields: { name: 'Fixed' }, flatten: true }]);
    expect((await PDFDocument.load(flat.bytes)).catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)?.lookupMaybe(PDFName.of('Fields'), PDFArray)?.size() ?? 0).toBe(0);
    expect(flat.forms).toMatchObject({ flattened: true, fields: [] });
    await expect(run([pdf], [{ op: 'fill_form', fields: { missing: 'x' }, flatten: false }])).rejects.toMatchObject({ message: 'form-field-mismatch' });
    await expect(run([pdf], [{ op: 'fill_form', fields: { agree: 'yes' }, flatten: false }])).rejects.toMatchObject({ message: 'form-field-mismatch' });
    await expect(run([pdf], [{ op: 'fill_form', fields: { choice: 'maybe' }, flatten: false }])).rejects.toMatchObject({ message: 'form-field-mismatch' });
  });

  it('deleting a page drops only its widgets; the other fields keep working', async () => {
    const pdf = await makeFormPdf();
    const result = await run([pdf], [{ op: 'delete_pages', pages: '2' }]);
    expect(result.removed).toMatchObject({ fields: ['agree'], widgets: 2 });
    const form = (await PDFDocument.load(result.bytes)).getForm();
    expect(form.getFields().map(field => field.getName()).sort()).toEqual(['choice', 'city', 'name', 'shared']);
    expect(form.getTextField('shared').acroField.getWidgets()).toHaveLength(1);
    form.getTextField('shared').setText('ok'); expect(form.getTextField('shared').getText()).toBe('ok');
  });

  it('refuses merging form PDFs by default and flattens them only when asked', async () => {
    const form = await makeFormPdf(); const plain = await makePdf([{ text: 'Plain' }]);
    await expect(run([form, plain], [{ op: 'merge' }], { inputCount: 2 })).rejects.toMatchObject({ message: 'pdf-form-merge-unsupported' });
    await expect(run([form], [{ op: 'extract_pages', pages: '1' }])).rejects.toMatchObject({ message: 'pdf-form-merge-unsupported' });
    const merged = await run([form, plain], [{ op: 'merge' }], { inputCount: 2, flatten: true });
    expect(merged.forms.flattened_inputs).toEqual([0]); expect(merged.pages).toBe(3);
  });

  it('removes outline items and links that point at a deleted page and reports them', async () => {
    const pdf = await makeOutlinedPdf();
    const result = await run([pdf], [{ op: 'delete_pages', pages: '2' }]);
    expect(result.removed).toMatchObject({ outline_items: ['Second'], links: 1 });
    const output = await PDFDocument.load(result.bytes); const outlines = output.catalog.lookup(PDFName.of('Outlines'), PDFDict);
    const first = outlines.lookup(PDFName.of('First'), PDFDict);
    expect((first.lookup(PDFName.of('Title')) as PDFString).decodeText()).toBe('First'); expect(outlines.get(PDFName.of('Count'))?.toString()).toBe('1');
    expect(output.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.size() ?? 0).toBe(0);
    const merged = await run([pdf, await makePdf([{ text: 'x' }])], [{ op: 'merge' }], { inputCount: 2 });
    expect(merged.dropped).toContain('outlines');
  });

  it('refuses encrypted, digitally signed and XFA inputs', async () => {
    const base = await PDFDocument.load(await makePdf([{ text: 'Secret' }]));
    base.context.trailerInfo.Encrypt = base.context.register(base.context.obj({ Filter: 'Standard', V: 1, R: 2 }));
    await expect(run([await base.save()], [{ op: 'rotate_pages', pages: '1', degrees: 90 }])).rejects.toMatchObject({ message: 'pdf-encrypted' });
    const signed = await PDFDocument.load(await makePdf([{ text: 'Signed' }])); const context = signed.context;
    const value = context.register(context.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite' }));
    // An inherited FT: the parent names /Sig, the merged kid field/widget carries the value.
    const parent = context.register(context.obj({ FT: 'Sig', T: PDFString.of('sig'), Kids: [] }));
    const kid = context.register(context.obj({ T: PDFString.of('a'), Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 0, 0], Parent: parent, V: value }));
    context.lookup(parent, PDFDict).lookup(PDFName.of('Kids'), PDFArray).push(kid);
    signed.catalog.set(PDFName.of('AcroForm'), context.obj({ Fields: [parent] }));
    await expect(run([await signed.save()], [{ op: 'rotate_pages', pages: '1', degrees: 90 }])).rejects.toMatchObject({ message: 'pdf-signed' });
    // getForm() would strip the XFA entry; set it on the stored AcroForm dictionary directly.
    const xfa = await PDFDocument.load(await makeFormPdf());
    xfa.catalog.lookup(PDFName.of('AcroForm'), PDFDict).set(PDFName.of('XFA'), xfa.context.obj([PDFString.of('template'), xfa.context.register(xfa.context.stream('<xdp/>'))]));
    await expect(run([await xfa.save({ updateFieldAppearances: false })], [{ op: 'rotate_pages', pages: '1', degrees: 90 }])).rejects.toMatchObject({ message: 'pdf-xfa-unsupported' });
  });

  it('replaces a contiguous range with pages of another source and drops their earlier overlays', async () => {
    const composite = await makePdf([{ text: 'Old contract 1' }, { text: 'Old contract 2' }, { text: 'Annex' }]);
    const regenerated = await makePdf([{ text: 'New contract 1' }, { text: 'New contract 2' }, { text: 'New contract 3' }]);
    const result = await run([composite, regenerated], [{ op: 'replace_pages', pages: '1-2', from: { source: 1 } }]);
    expect(result.page_map).toEqual([{ source: 1, page: 1, rotated: 0 }, { source: 1, page: 2, rotated: 0 }, { source: 1, page: 3, rotated: 0 }, { source: 0, page: 3, rotated: 0 }]);
    expect(await texts(result.bytes)).toEqual(['New contract 1', 'New contract 2', 'New contract 3', 'Annex']);
  });
});

describe('edit_pdf engine: overlays and annotations (P4a)', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const image = { bytes: new Uint8Array(PNG), sha256: sha(PNG), mime: 'image/png' as const };
  const runWith = (pdf: Uint8Array, operations: PdfEngineOperation[], fonts = testFonts()) =>
    runPdfEdit({ sources: [source(pdf)], inputCount: 1, operations, flattenFormsBeforeMerge: false, fonts, images: [image] }, textPort);
  const annotations = (doc: PDFDocument, page: number) => {
    const annots = doc.getPage(page).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    return annots ? annots.asArray().map((_entry, index) => annots.lookup(index, PDFDict)) : [];
  };

  it('writes text at a visible position on rotated and cropped pages', async () => {
    const pdf = await makePdf([{ text: 'Base', rotate: 90 }, { text: 'Crop', crop: [20, 30, 250, 300] }]);
    const result = await runWith(pdf, [{ op: 'add_text', page: 1, x: 50, y: 40, text: 'Hello\nWorld', size: 12, color: '000000' }, { op: 'add_text', page: 2, x: 10, y: 10, text: 'Top', size: 12, color: '000000' }]);
    const output = await PDFDocument.load(result.bytes); const items = await textPort.pages(result.bytes);
    const where = (page: number, needle: string) => { const item = items[page].find(entry => entry.str.includes(needle))!; return userToVisible(visibleGeometry(output.getPage(page)), item.transform[4], item.transform[5]); };
    const [x1, y1] = where(0, 'Hello'); expect(x1).toBeCloseTo(50, 0); expect(y1).toBeGreaterThan(40); expect(y1).toBeLessThan(40 + 12);
    const [, y2] = where(0, 'World'); expect(y2 - y1).toBeCloseTo(14.4, 0);
    const [x3, y3] = where(1, 'Top'); expect(x3).toBeCloseTo(10, 0); expect(y3).toBeLessThan(22);
    await expect(runWith(pdf, [{ op: 'add_text', page: 1, x: 390, y: 10, text: 'Too far right', size: 12, color: '000000' }])).rejects.toMatchObject({ message: 'invalid-pdf-edits' });
  });

  it('fits an image in its rectangle and adds a note annotation inside the page', async () => {
    const pdf = await makePdf([{ text: 'Image page' }]);
    const result = await runWith(pdf, [{ op: 'add_image', page: 1, rect: [100, 100, 50, 20], image: 0 }, { op: 'add_note', page: 1, x: 10, y: 10, text: 'Check this\nclause' }]);
    expect(result.images).toEqual([{ page: 1, sha256: image.sha256, rect: [100, 100, 50, 20], output_page: 1 }]); expect(result.checks).toMatchObject({ images: 1, annotations: 1 });
    const output = await PDFDocument.load(result.bytes); const [note] = annotations(output, 0);
    expect(note.lookup(PDFName.of('Subtype'))?.toString()).toBe('/Text'); expect((note.lookup(PDFName.of('Contents')) as PDFHexString).decodeText()).toBe('Check this\nclause');
    expect(note.lookup(PDFName.of('Rect'), PDFArray).asArray().map(value => Number(value.toString()))).toEqual([10, 370, 30, 390]);
    await expect(runWith(pdf, [{ op: 'add_image', page: 1, rect: [290, 100, 50, 20], image: 0 }])).rejects.toMatchObject({ message: 'invalid-pdf-edits' });
    await expect(runWith(pdf, [{ op: 'add_image', page: 2, rect: [10, 10, 5, 5], image: 0 }])).rejects.toMatchObject({ message: 'invalid-pages' });
  });

  it('highlights a match in the middle of one item and a match across two items, or reports text-not-found', async () => {
    const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica); const page = doc.addPage([300, 400]);
    page.drawText('Alpha Beta Gamma', { x: 40, y: 300, size: 12, font }); page.drawText('Delta Epsilon', { x: 40, y: 280, size: 12, font });
    const pdf = await doc.save();
    const result = await runWith(pdf, [{ op: 'add_highlight', page: 1, find: 'Beta', occurrence: 1, color: 'ffff00' }, { op: 'add_highlight', page: 1, find: 'GammaDelta', occurrence: 1, color: '00ff00' }]);
    expect(result.annotations.map(item => [item.quads, item.granularity])).toEqual([[1, 'text-item'], [2, 'text-item']]);
    const [first, second] = annotations(await PDFDocument.load(result.bytes), 0);
    const quad = first.lookup(PDFName.of('QuadPoints'), PDFArray).asArray().map(value => Number(value.toString()));
    expect(quad[0]).toBeCloseTo(40, 0); expect(quad[2]).toBeGreaterThan(110); expect(quad[1]).toBeGreaterThan(300); expect(quad[5]).toBeLessThan(300);
    expect(second.lookup(PDFName.of('QuadPoints'), PDFArray).size()).toBe(16); expect(second.lookup(PDFName.of('AP'), PDFDict).has(PDFName.of('N'))).toBe(true);
    await expect(runWith(pdf, [{ op: 'add_highlight', page: 1, find: 'Beta', occurrence: 2, color: 'ffff00' }])).rejects.toMatchObject({ message: 'text-not-found' });
    const rect = await runWith(pdf, [{ op: 'add_highlight', page: 1, rect: [10, 10, 100, 20], occurrence: 1, color: 'ffff00' }]);
    expect(rect.annotations[0]).toMatchObject({ granularity: 'rect', quads: 1 });
  });

  it('read-back refuses an annotation that is not on its page and a missing image', async () => {
    const pdf = await makePdf([{ text: 'Note page' }]);
    // The output text layer is reported as the input's, so only the structure checks can notice the fault.
    const inputText = await textPort.pages(pdf); const tampered = { pages: async () => inputText };
    const original = PDFDocument.prototype.save;
    try {
      // Fault injection: the saved output loses the page's Annots entry.
      PDFDocument.prototype.save = async function (this: PDFDocument, options?: any) { this.getPages().forEach(page => page.node.delete(PDFName.of('Annots'))); return original.call(this, options); };
      await expect(runPdfEdit({ sources: [source(pdf)], inputCount: 1, operations: [{ op: 'add_note', page: 1, x: 10, y: 10, text: 'n' }], flattenFormsBeforeMerge: false, fonts: testFonts() }, tampered))
        .rejects.toMatchObject({ message: 'pdf-output-check-failed' });
      // Fault injection: the saved output loses the page's image resources.
      PDFDocument.prototype.save = async function (this: PDFDocument, options?: any) {
        this.getPages().forEach(page => page.node.Resources()?.delete(PDFName.of('XObject'))); return original.call(this, options);
      };
      await expect(runPdfEdit({ sources: [source(pdf)], inputCount: 1, operations: [{ op: 'add_image', page: 1, rect: [10, 10, 20, 20], image: 0 }], flattenFormsBeforeMerge: false, fonts: testFonts(), images: [image] }, tampered))
        .rejects.toMatchObject({ message: 'pdf-output-check-failed' });
    } finally { PDFDocument.prototype.save = original; }
  });
});

describe('edit_pdf request validation', () => {
  const base = { schema_version: 1, destination: 'out.pdf', inputs: [{ path: 'a.pdf' }], operations: [{ op: 'rotate_pages', pages: '1', degrees: 90 }] };
  it('normalizes a valid request and names the invalid field', () => {
    expect(validatePdfEditRequest(base)).toMatchObject({ destination: 'out.pdf', flatten_forms_before_merge: false });
    expect(() => validatePdfEditRequest({ ...base, destination: 'out.docx' })).toThrow('destination-extension-mismatch');
    expect(() => validatePdfEditRequest({ ...base, inputs: [{ path: 'a.pdf' }, { path: 'b.pdf' }] })).toThrow('invalid-pdf-edits');
    expect(() => validatePdfEditRequest({ ...base, operations: [{ op: 'merge' }] })).toThrow('invalid-pdf-edits');
    expect(() => validatePdfEditRequest({ ...base, operations: [{ op: 'rotate_pages', pages: '3-1', degrees: 90 }] })).not.toThrow();
    expect(() => validatePdfEditRequest({ ...base, operations: [{ op: 'rotate_pages', pages: 'x', degrees: 90 }] })).toThrow('invalid-pdf-edits');
    expect(() => validatePdfEditRequest({ ...base, operations: [{ op: 'fill_form', fields: { a: 'b' } }] })).toThrow('invalid-pdf-edits');
    expect(() => validatePdfEditRequest({ ...base, operations: [{ op: 'add_page_numbers', format: '{page}' }] })).toThrow('invalid-pdf-edits');
  });
});
