import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { MAY_MUTATE_WORKSPACE_TOOLS, WorkspaceTools, requiresTrustedWorkspace } from '../WorkspaceTools';
import { HOST_WORKSPACE_TOOL_NAMES } from '../HostToolNames';
import { isGovernedWorkspaceTool } from '../requestBoundary';
import { activityTool } from '../../observability/TurnActivity';
import { isToolAllowedInPlan } from '../planMode';
import type { PdfEditor } from '../../office/pdf/PdfEditor';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { makeFormPdf, makePdf, sha, textPort } from '../../office/pdf/__tests__/pdfFixtures';
import { pdfRouteEditor } from './pdfRouteFixtures';
import { admitUserTurn, attachment, attachmentIds, saveHost } from './attachmentSaveFixtures';
import { PRESENTATION_PNG } from './presentationImageFixtures';

let editor: PdfEditor | undefined;
const owned: WorkspaceTools[] = [];
afterEach(async () => { for (const tools of owned.splice(0)) tools.retire(); await removeTemporaryFolders(); editor = undefined; });
async function host(allowed = new Set(['read', 'write']), approval?: () => Promise<'once' | 'deny'>) {
  const root = await temporaryFolder('unode-pdf-edit-');
  const parameters: ConstructorParameters<typeof WorkspaceTools> = [root, allowed, 'agent'];
  if (approval) { parameters[11] = () => true; parameters[12] = approval as any; }
  const tools = new WorkspaceTools(...parameters); editor ??= await pdfRouteEditor(); tools.setPdfEditor(editor); tools.beginTurn(); owned.push(tools);
  return { root, tools };
}
const texts = async (bytes: Uint8Array) => (await textPort.pages(bytes)).map(items => items.map(item => item.str).join(''));

it('registered edit_pdf merges workspace PDFs, watermarks and numbers them, and commits the read-back output', async () => {
  const { root, tools } = await host(); expect(tools.specs().some(spec => spec.function.name === 'edit_pdf')).toBe(true);
  const a = await makePdf([{ text: 'Contract page 1' }, { text: 'Contract page 2' }]); const b = await makePdf([{ text: 'Annex page' }]);
  await fs.writeFile(join(root, 'contract.pdf'), a); await fs.writeFile(join(root, 'annex.pdf'), b);
  const result = await tools.run('edit_pdf', { schema_version: 1, destination: 'out/packet.pdf', inputs: [{ path: 'contract.pdf' }, { path: 'annex.pdf' }],
    operations: [{ op: 'merge' }, { op: 'add_watermark', text: '草稿' }, { op: 'add_page_numbers' }] });
  expect(result.status, result.output).toBe('success'); expect(result).toMatchObject({ name: 'edit_pdf', kind: 'write', path: 'out/packet.pdf' });
  const output = await fs.readFile(join(root, 'out', 'packet.pdf'));
  expect(result.output).toContain(`SHA-256: ${sha(output)}`); expect(result.output).toContain('"kind":"pdf-edited"'); expect(result.output).toContain('copied text matched on 3 pages');
  expect(result.output).toContain(`#1 SHA-256 ${sha(a)}`); expect(result.output).toContain('1<-#1p1 2<-#1p2 3<-#2p1');
  const pages = await texts(output); expect(pages[0]).toContain('Contract page 1'); expect(pages[0]).toContain('草稿'); expect(pages[2].replace(/\s/g, '')).toContain('3/3');
  expect(await fs.readFile(join(root, 'contract.pdf'))).toEqual(Buffer.from(a));
});

it('edit_pdf never writes over an input and refuses without Write', async () => {
  const { root, tools } = await host(); const pdf = await makePdf([{ text: 'Only' }]); await fs.writeFile(join(root, 'in.pdf'), pdf);
  const same = await tools.run('edit_pdf', { schema_version: 1, destination: 'in.pdf', inputs: [{ path: 'in.pdf' }], operations: [{ op: 'rotate_pages', pages: '1', degrees: 90 }] });
  expect(same.status).toBe('failed'); expect(same.output).toContain('pdf-destination-is-input'); expect(await fs.readFile(join(root, 'in.pdf'))).toEqual(Buffer.from(pdf));
  const reader = await host(new Set(['read'])); await fs.writeFile(join(reader.root, 'in.pdf'), pdf);
  expect(reader.tools.specs().some(spec => spec.function.name === 'edit_pdf')).toBe(false);
  const refused = await reader.tools.run('edit_pdf', { schema_version: 1, destination: 'out.pdf', inputs: [{ path: 'in.pdf' }], operations: [{ op: 'rotate_pages', pages: '1', degrees: 90 }] });
  expect(refused.status).toBe('refused'); await expect(fs.stat(join(reader.root, 'out.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('edit_pdf fills a form and reports a typed failure for a merge of form PDFs', async () => {
  const { root, tools } = await host(); await fs.writeFile(join(root, 'form.pdf'), await makeFormPdf()); await fs.writeFile(join(root, 'plain.pdf'), await makePdf([{ text: 'Plain' }]));
  const filled = await tools.run('edit_pdf', { schema_version: 1, destination: 'filled.pdf', inputs: [{ path: 'form.pdf' }], operations: [{ op: 'fill_form', fields: { name: 'Ada', agree: true }, flatten: false }] });
  expect(filled.status, filled.output).toBe('success'); expect(filled.output).toContain('Filled fields: "name", "agree"');
  const form = (await PDFDocument.load(await fs.readFile(join(root, 'filled.pdf')))).getForm(); expect(form.getTextField('name').getText()).toBe('Ada');
  const merge = await tools.run('edit_pdf', { schema_version: 1, destination: 'merged.pdf', inputs: [{ path: 'form.pdf' }, { path: 'plain.pdf' }], operations: [{ op: 'merge' }] });
  expect(merge.status).toBe('failed'); expect(merge.output).toContain('pdf-form-merge-unsupported'); expect(merge.output).toContain('flatten_forms_before_merge');
  await expect(fs.stat(join(root, 'merged.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('edit_pdf is a named, governed, trust-gated write tool that Plan mode never offers', async () => {
  expect(HOST_WORKSPACE_TOOL_NAMES).toContain('edit_pdf'); expect(isGovernedWorkspaceTool('edit_pdf')).toBe(true); expect(activityTool('edit_pdf')).toBe('edit_pdf');
  expect(requiresTrustedWorkspace('edit_pdf')).toBe(true); expect(MAY_MUTATE_WORKSPACE_TOOLS).toContain('edit_pdf'); expect(isToolAllowedInPlan('edit_pdf')).toBe(false);
  const parameters: ConstructorParameters<typeof WorkspaceTools> = [await temporaryFolder('unode-pdf-untrusted-'), new Set(['read', 'write']), 'agent']; parameters[17] = () => false;
  const untrusted = new WorkspaceTools(...parameters); owned.push(untrusted); await fs.writeFile(join(parameters[0], 'in.pdf'), await makePdf([{ text: 'x' }]));
  const result = await untrusted.run('edit_pdf', { schema_version: 1, destination: 'out.pdf', inputs: [{ path: 'in.pdf' }], operations: [{ op: 'rotate_pages', pages: '1', degrees: 90 }] });
  expect(result).toMatchObject({ status: 'refused', reason: 'trust' }); await expect(fs.stat(join(parameters[0], 'out.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('registered edit_pdf places a user image asset, a note and a highlight, and refuses an asset outside the request', async () => {
  const h = await saveHost(); const sources = await admitUserTurn(h.assets, [attachment('stamp.png', 'image/png', 'image', PRESENTATION_PNG)]);
  const tools = h.tools('dev', sources); editor ??= await pdfRouteEditor(); tools.setPdfEditor(editor); tools.beginTurn(); owned.push(tools);
  try {
    await fs.writeFile(join(h.root, 'in.pdf'), await makePdf([{ text: 'Terms and conditions apply' }]));
    const result = await tools.run('edit_pdf', { schema_version: 1, destination: 'marked.pdf', inputs: [{ path: 'in.pdf' }], operations: [
      { op: 'add_image', page: 1, rect: [20, 20, 60, 60], asset_ref: attachmentIds(sources)[0] }, { op: 'add_note', page: 1, x: 200, y: 20, text: 'Review' },
      { op: 'add_highlight', page: 1, find: 'conditions' }] });
    expect(result.status, result.output).toBe('success'); expect(result.output).toContain('granularity text-item');
    expect(result.output).toContain(`Image SHA-256 ${sha(PRESENTATION_PNG)} placed on page 1`); expect(result.output).toContain('images present 1');
    const output = await PDFDocument.load(await fs.readFile(join(h.root, 'marked.pdf')));
    expect(output.getPage(0).node.Annots()?.size()).toBe(2);
    const outside = await tools.run('edit_pdf', { schema_version: 1, destination: 'other.pdf', inputs: [{ path: 'in.pdf' }], operations: [{ op: 'add_image', page: 1, rect: [20, 20, 60, 60], asset_ref: 'content-999' }] });
    expect(outside.status).toBe('failed'); expect(outside.output).toContain('image-unavailable');
  } finally { await h.assets.dispose(); }
});

it('P2 audit F1: clearing a text field with an empty string succeeds and leaves it empty and editable', async () => {
  const { root, tools } = await host(); const filled = await PDFDocument.load(await makeFormPdf()); filled.getForm().getTextField('name').setText('Previous');
  await fs.writeFile(join(root, 'form.pdf'), await filled.save());
  const result = await tools.run('edit_pdf', { schema_version: 1, destination: 'cleared.pdf', inputs: [{ path: 'form.pdf' }], operations: [{ op: 'fill_form', fields: { name: '' }, flatten: false }] });
  expect(result.status, result.output).toBe('success');
  const field = (await PDFDocument.load(await fs.readFile(join(root, 'cleared.pdf')))).getForm().getTextField('name');
  expect(field.getText() ?? '').toBe(''); expect(field.isReadOnly()).toBe(false); field.setText('again'); expect(field.getText()).toBe('again');
});

it('P2 audit F2: filling the same field twice keeps and checks only the final value', async () => {
  const { root, tools } = await host(); await fs.writeFile(join(root, 'form.pdf'), await makeFormPdf());
  const result = await tools.run('edit_pdf', { schema_version: 1, destination: 'twice.pdf', inputs: [{ path: 'form.pdf' }],
    operations: [{ op: 'fill_form', fields: { name: 'Ada' }, flatten: false }, { op: 'fill_form', fields: { name: 'Grace' }, flatten: false }] });
  expect(result.status, result.output).toBe('success');
  expect((await PDFDocument.load(await fs.readFile(join(root, 'twice.pdf')))).getForm().getTextField('name').getText()).toBe('Grace');
});

it('P2 audit F3: a descending replace_pages range is refused with invalid-pages and writes nothing', async () => {
  const { root, tools } = await host();
  await fs.writeFile(join(root, 'three.pdf'), await makePdf([{ text: 'One' }, { text: 'Two' }, { text: 'Three' }])); await fs.writeFile(join(root, 'new.pdf'), await makePdf([{ text: 'Replacement' }]));
  const refused = await tools.run('edit_pdf', { schema_version: 1, destination: 'bad.pdf', inputs: [{ path: 'three.pdf' }], operations: [{ op: 'replace_pages', pages: '3-1', from: { path: 'new.pdf' } }] });
  expect(refused.status).toBe('failed'); expect(refused.output).toContain('invalid-pages'); await expect(fs.stat(join(root, 'bad.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
  const replaced = await tools.run('edit_pdf', { schema_version: 1, destination: 'good.pdf', inputs: [{ path: 'three.pdf' }], operations: [{ op: 'replace_pages', pages: '2-3', from: { path: 'new.pdf' } }] });
  expect(replaced.status, replaced.output).toBe('success'); expect(await texts(await fs.readFile(join(root, 'good.pdf')))).toEqual(['One', 'Replacement']);
});

it('P4a audit F3: a note on a page that a later operation deletes goes with the page; a note on a kept page is checked where it lands', async () => {
  const { root, tools } = await host(); await fs.writeFile(join(root, 'in.pdf'), await makePdf([{ text: 'First' }, { text: 'Second' }]));
  const gone = await tools.run('edit_pdf', { schema_version: 1, destination: 'gone.pdf', inputs: [{ path: 'in.pdf' }], operations: [{ op: 'add_note', page: 1, x: 10, y: 10, text: 'n' }, { op: 'delete_pages', pages: '1' }] });
  expect(gone.status, gone.output).toBe('success'); expect(gone.output).toContain('was removed with that page by a later operation');
  expect((await PDFDocument.load(await fs.readFile(join(root, 'gone.pdf')))).getPageCount()).toBe(1);
  const kept = await tools.run('edit_pdf', { schema_version: 1, destination: 'kept.pdf', inputs: [{ path: 'in.pdf' }], operations: [{ op: 'add_note', page: 2, x: 10, y: 10, text: 'n' }, { op: 'delete_pages', pages: '1' }] });
  expect(kept.status, kept.output).toBe('success'); expect(kept.output).toContain('now output page 1'); expect(kept.output).toContain('annotations inside their pages 1');
  expect((await PDFDocument.load(await fs.readFile(join(root, 'kept.pdf')))).getPage(0).node.Annots()?.size()).toBe(1);
});

it('P4a audit note: a highlight on a page that later operations move is reported on its output page, like a note or an image', async () => {
  const { root, tools } = await host(); await fs.writeFile(join(root, 'in.pdf'), await makePdf([{ text: 'First' }, { text: 'Second' }]));
  const moved = await tools.run('edit_pdf', { schema_version: 1, destination: 'moved.pdf', inputs: [{ path: 'in.pdf' }],
    operations: [{ op: 'add_highlight', page: 2, rect: [10, 10, 100, 20] }, { op: 'delete_pages', pages: '1' }] });
  expect(moved.status, moved.output).toBe('success');
  expect(moved.output).toMatch(/Highlight annotation on page 2: [^\n]*; now output page 1\./);
  expect((await PDFDocument.load(await fs.readFile(join(root, 'moved.pdf')))).getPage(0).node.Annots()?.size()).toBe(1);
  const still = await tools.run('edit_pdf', { schema_version: 1, destination: 'still.pdf', inputs: [{ path: 'in.pdf' }], operations: [{ op: 'add_highlight', page: 1, rect: [10, 10, 100, 20] }] });
  expect(still.status, still.output).toBe('success'); expect(still.output).toMatch(/Highlight annotation on page 1: [^\n]*\./); expect(still.output).not.toContain('now output page');
});

it('edit_pdf stops before the commit when an input changes while the write approval is pending', async () => {
  let rootFolder = '';
  const { root, tools } = await host(undefined, async () => { await fs.writeFile(join(rootFolder, 'in.pdf'), await makePdf([{ text: 'Changed' }])); return 'once'; });
  rootFolder = root; await fs.writeFile(join(root, 'in.pdf'), await makePdf([{ text: 'Original' }]));
  const result = await tools.run('edit_pdf', { schema_version: 1, destination: 'out.pdf', inputs: [{ path: 'in.pdf' }], operations: [{ op: 'rotate_pages', pages: '1', degrees: 90 }] });
  expect(result.status).toBe('failed'); expect(result.output).toContain('An input PDF changed');
  await expect(fs.stat(join(root, 'out.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
});
