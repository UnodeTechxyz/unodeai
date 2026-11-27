import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import UPNG from '@pdf-lib/upng';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { saveHost } from './attachmentSaveFixtures';
import { pdfRouteEditor } from './pdfRouteFixtures';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';
import { makePdf, textPort } from '../../office/pdf/__tests__/pdfFixtures';
import { PdfSignatureStore, rotateVisibleRect, signatureSaveNotice } from '../../office/pdf/PdfSignatureStore';
import type { OverwriteDecisionRequest } from '../fileWritePolicy';
import type { PdfEditor } from '../../office/pdf/PdfEditor';

/** A 4x2 RGBA signature: opaque ink on a transparent background. */
function signaturePng(opaque = false): Buffer {
  const pixels = new Uint8Array(4 * 2 * 4); for (let at = 0; at < pixels.length; at += 4) pixels.set([10, 20, 120, opaque || at < 16 ? 255 : 0], at);
  return Buffer.from(UPNG.encode([pixels.buffer], 4, 2, 0));
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let editor: PdfEditor | undefined;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); await removeTemporaryFolders(); editor = undefined; });

async function signingHost(decide: (request: OverwriteDecisionRequest) => Promise<'once' | 'deny'> | 'once' | 'deny', withSignature = true, writeApproval?: () => Promise<'once'>) {
  const h = await saveHost({ decide: async request => decide(request), ...(writeApproval ? { ask: true, approve: writeApproval } : {}) }); const tools = h.tools('dev');
  editor ??= await pdfRouteEditor(); tools.setPdfEditor(editor); tools.beginTurn();
  const store = new PdfSignatureStore(join(await temporaryFolder('unode-signature-store-'), 'signature'));
  if (withSignature) expect((await store.save(signaturePng())).ok).toBe(true);
  tools.setPdfSignatures(store); cleanup.push(async () => { tools.retire(); await h.assets.dispose(); });
  return { ...h, tools, store };
}
const imagesOn = async (bytes: Uint8Array, page: number) => {
  const doc = await PDFDocument.load(bytes); const objects = doc.getPage(page - 1).node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  return objects?.keys().length ?? 0;
};

it('place_signature runs last on the final page numbering, after one confirmation bound to the unsigned candidate', async () => {
  const requests: OverwriteDecisionRequest[] = [];
  const h = await signingHost(request => { requests.push(request); return 'once'; });
  await fs.writeFile(join(h.root, 'contract.pdf'), await makePdf([{ text: 'Cover' }, { text: 'Signature page' }]));
  const result = await h.tools.run('edit_pdf', { schema_version: 1, destination: 'signed.pdf', inputs: [{ path: 'contract.pdf' }], operations: [
    { op: 'place_signature', page: 1, rect: [40, 300, 120, 60] }, { op: 'reorder_pages', order: [2, 1] }, { op: 'add_watermark', text: 'DRAFT' }] });
  expect(result.status, result.output).toBe('success');
  const signing = requests.filter(request => request.purpose === 'pdf-signature'); expect(signing).toHaveLength(1);
  expect(signing[0].preview).toContain('Page 1 of 2'); expect(signing[0].preview).toContain('Page text begins: Signature page'); expect(signing[0].preview).toContain(`Signature image SHA-256: ${sha(signaturePng())}`);
  const output = await fs.readFile(join(h.root, 'signed.pdf'));
  expect(await imagesOn(output, 1)).toBe(1); expect(await imagesOn(output, 2)).toBe(0);
  expect(result.output).toMatch(/Signature placed on page 1 at \[40, 300, 120, 60\] pt after confirmation by .+ at \d{4}-/);
  expect(JSON.parse(result.output.split('Receipt: ')[1]).signatures).toEqual([expect.objectContaining({ page: 1, result: 'placed', signature_sha256: sha(signaturePng()) })]);
  expect(await h.store.recordsFor(sha(output))).toEqual([expect.objectContaining({ page: 1, rect: [40, 300, 120, 60], page_size: [300, 400] })]);
  expect((await textPort.pages(output))[0].map(item => item.str).join('')).toContain('Signature page');
});

it('a declined placement is skipped and reported while the rest of the request completes', async () => {
  let count = 0; const h = await signingHost(() => (++count === 1 ? 'deny' : 'once'));
  await fs.writeFile(join(h.root, 'in.pdf'), await makePdf([{ text: 'One' }, { text: 'Two' }]));
  const result = await h.tools.run('edit_pdf', { schema_version: 1, destination: 'out.pdf', inputs: [{ path: 'in.pdf' }], operations: [
    { op: 'add_page_numbers' }, { op: 'place_signature', page: 1, rect: [10, 10, 50, 20] }, { op: 'place_signature', page: 2, rect: [10, 10, 50, 20] }] });
  expect(result.status, result.output).toBe('success'); expect(result.output).toContain('Signature on page 1 was declined by the user and not placed (signature-declined)');
  expect(result.output).toContain('Signature placed on page 2'); const output = await fs.readFile(join(h.root, 'out.pdf'));
  expect(await imagesOn(output, 1)).toBe(0); expect(await imagesOn(output, 2)).toBe(1);
  expect((await textPort.pages(output))[0].map(item => item.str).join('').replace(/\s/g, '')).toContain('1/2');
});

it('a change while the confirmation waits makes the call signature-confirmation-stale and writes nothing', async () => {
  let root = '';
  const h = await signingHost(async () => { await fs.writeFile(join(root, 'in.pdf'), await makePdf([{ text: 'Changed' }])); return 'once'; });
  root = h.root; await fs.writeFile(join(h.root, 'in.pdf'), await makePdf([{ text: 'Original' }]));
  const result = await h.tools.run('edit_pdf', { schema_version: 1, destination: 'out.pdf', inputs: [{ path: 'in.pdf' }], operations: [{ op: 'place_signature', page: 1, rect: [10, 10, 50, 20] }] });
  expect(result.status).toBe('failed'); expect(result.output).toContain('signature-confirmation-stale');
  await expect(fs.stat(join(h.root, 'out.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('replacing the saved signature while a placement waits also makes the call stale', async () => {
  const holder: { store?: PdfSignatureStore } = {};
  const h = await signingHost(async () => { await holder.store!.save(Buffer.from(UPNG.encode([new Uint8Array(4 * 2 * 4).fill(0).buffer], 4, 2, 0))); return 'once'; });
  holder.store = h.store; await fs.writeFile(join(h.root, 'in.pdf'), await makePdf([{ text: 'Original' }]));
  const result = await h.tools.run('edit_pdf', { schema_version: 1, destination: 'out.pdf', inputs: [{ path: 'in.pdf' }], operations: [{ op: 'place_signature', page: 1, rect: [10, 10, 50, 20] }] });
  expect(result.status).toBe('failed'); expect(result.output).toContain('signature-confirmation-stale');
  await expect(fs.stat(join(h.root, 'out.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('P4a audit F1: the saved signature is re-read at the final commit, after the ordinary write approval waits', async () => {
  const holder: { store?: PdfSignatureStore } = {};
  const h = await signingHost(() => 'once', true, async () => { await holder.store!.delete(); return 'once'; });
  holder.store = h.store; await fs.writeFile(join(h.root, 'in.pdf'), await makePdf([{ text: 'Sign here' }]));
  const result = await h.tools.run('edit_pdf', { schema_version: 1, destination: 'out.pdf', inputs: [{ path: 'in.pdf' }], operations: [{ op: 'place_signature', page: 1, rect: [10, 10, 50, 20] }] });
  expect(result.status).toBe('failed'); expect(result.output).toContain('signature-confirmation-stale');
  await expect(fs.stat(join(h.root, 'out.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
  // Control: the same waits with the signature unchanged commit the signed PDF.
  const kept = await signingHost(() => 'once', true, async () => 'once'); await fs.writeFile(join(kept.root, 'in.pdf'), await makePdf([{ text: 'Sign here' }]));
  const signed = await kept.tools.run('edit_pdf', { schema_version: 1, destination: 'out.pdf', inputs: [{ path: 'in.pdf' }], operations: [{ op: 'place_signature', page: 1, rect: [10, 10, 50, 20] }] });
  expect(signed.status, signed.output).toBe('success'); expect(await imagesOn(await fs.readFile(join(kept.root, 'out.pdf')), 1)).toBe(1);
});

it('without a saved signature the placement reports signature-unavailable, asks nothing, and the edit completes', async () => {
  const requests: OverwriteDecisionRequest[] = []; const h = await signingHost(request => { requests.push(request); return 'once'; }, false);
  await fs.writeFile(join(h.root, 'in.pdf'), await makePdf([{ text: 'One' }]));
  const result = await h.tools.run('edit_pdf', { schema_version: 1, destination: 'out.pdf', inputs: [{ path: 'in.pdf' }], operations: [{ op: 'rotate_pages', pages: '1', degrees: 90 }, { op: 'place_signature', page: 1, rect: [10, 10, 50, 20] }] });
  expect(result.status, result.output).toBe('success'); expect(result.output).toContain('signature-unavailable'); expect(result.output).toContain('Settings > More > My signature');
  expect(requests.filter(request => request.purpose === 'pdf-signature')).toEqual([]);
});

it('signature records follow a later rotation and are invalidated with a replaced page', async () => {
  const h = await signingHost(() => 'once'); await fs.writeFile(join(h.root, 'in.pdf'), await makePdf([{ text: 'Sign here' }, { text: 'Annex' }]));
  expect((await h.tools.run('edit_pdf', { schema_version: 1, destination: 'signed.pdf', inputs: [{ path: 'in.pdf' }], operations: [{ op: 'place_signature', page: 1, rect: [40, 300, 120, 60] }] })).status).toBe('success');
  const rotated = await h.tools.run('edit_pdf', { schema_version: 1, destination: 'rotated.pdf', inputs: [{ path: 'signed.pdf' }], operations: [{ op: 'rotate_pages', pages: '1', degrees: 90 }, { op: 'reorder_pages', order: [2, 1] }] });
  expect(rotated.status, rotated.output).toBe('success'); expect(rotated.output).toContain('carried to this file: 1');
  expect(await h.store.recordsFor(sha(await fs.readFile(join(h.root, 'rotated.pdf'))))).toEqual([expect.objectContaining({ page: 2, rect: [40, 40, 60, 120], page_size: [400, 300] })]);
  await fs.writeFile(join(h.root, 'new.pdf'), await makePdf([{ text: 'New page one' }]));
  const replaced = await h.tools.run('edit_pdf', { schema_version: 1, destination: 'replaced.pdf', inputs: [{ path: 'signed.pdf' }], operations: [{ op: 'replace_pages', pages: '1', from: { path: 'new.pdf' } }] });
  expect(replaced.status, replaced.output).toBe('success'); expect(replaced.output).toContain('signature_invalidated');
  expect(await h.store.recordsFor(sha(await fs.readFile(join(h.root, 'replaced.pdf'))))).toEqual([]);
});

it('the signature store keeps only a transparent PNG up to 2 MB, and rotation mapping turns a full circle back', async () => {
  const store = new PdfSignatureStore(join(await temporaryFolder('unode-signature-only-'), 'signature'));
  expect(await store.save(signaturePng(true))).toEqual({ ok: false, reason: 'no-transparency' });
  expect(await store.save(Buffer.from('%PDF-1.4'))).toEqual({ ok: false, reason: 'not-png' });
  expect(await store.save(Buffer.alloc(2 * 1024 * 1024 + 1))).toEqual({ ok: false, reason: 'too-large' });
  expect(await store.save(signaturePng())).toMatchObject({ ok: true, status: { width: 4, height: 2, sha256: sha(signaturePng()) } });
  expect((await store.read())?.sha256).toBe(sha(signaturePng())); await store.delete(); expect(await store.read()).toBeUndefined();
  let state = { rect: [10, 20, 30, 40] as [number, number, number, number], size: [300, 400] as [number, number] };
  for (let turn = 0; turn < 4; turn++) state = rotateVisibleRect(state.rect, state.size, 90);
  expect(state).toEqual({ rect: [10, 20, 30, 40], size: [300, 400] });
});

it('the save notice says what Settings says: per-placement confirmation, image not sent, a signed PDF can show it (smoke 6ee15ae9)', async () => {
  const store = new PdfSignatureStore(join(await temporaryFolder('unode-signature-notice-'), 'signature'));
  const saved = signatureSaveNotice(await store.save(signaturePng()));
  expect(saved).toContain('only after you confirm each placement');
  expect(saved).toContain('is not sent to a model');
  expect(saved).toContain('an agent that reads that PDF with its own file reading or a command can see the signature');
  expect(saved).not.toMatch(/never see/i);
  expect(signatureSaveNotice(await store.save(signaturePng(true)))).toContain('no transparent background');
  expect(signatureSaveNotice(await store.save(Buffer.from('%PDF-1.4')))).toContain('not a readable PNG');
  expect(signatureSaveNotice(await store.save(Buffer.alloc(2 * 1024 * 1024 + 1)))).toContain('larger than 2 MB');
  expect(signatureSaveNotice({ ok: false, reason: 'unreadable' })).toBe('The signature could not be saved. Try again.');
});
