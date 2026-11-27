import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { attachment, admitUserTurn, saveHost, sha } from './attachmentSaveFixtures';
import { officeRouteAttachmentQualifier, officeRouteDocument } from './officeInventoryRouteFixtures';
import { typedXlsxFixture } from '../../content/__tests__/xlsxFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';
import { documentInput, documentRouteRenderer } from './documentRouteFixtures';

const owned: Array<Awaited<ReturnType<typeof host>>> = [];
afterEach(async () => { for (const h of owned.splice(0)) { h.tools.retire(); await h.assets.dispose(); } await removeTemporaryFolders(); });
async function host(bytes: Buffer, name: string) {
  const h = await saveHost({ capabilities: ['write'] }); const qualifier = await officeRouteAttachmentQualifier();
  const item = attachment(name, 'application/octet-stream', 'file', bytes); const sources = await admitUserTurn(h.assets, [item]);
  h.assets.holdForUserRequest('agent', sources.map(source => source.assetId)); const tools = h.tools('agent', sources); tools.setOfficeAttachmentQualifier(qualifier); tools.beginTurn();
  const value = { ...h, tools, qualifier, id: item.contentAssetId!, bytes }; owned.push(value); return value;
}
const profile = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
  docm: 'application/vnd.ms-word.document.macroEnabled.main+xml', dotm: 'application/vnd.ms-word.template.macroEnabledTemplate.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  potx: 'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml', ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml', potm: 'application/vnd.ms-powerpoint.template.macroEnabled.main+xml', ppsm: 'application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', xltx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml', xltm: 'application/vnd.ms-excel.template.macroEnabled.main+xml',
} as const;
async function packageOf(type: keyof typeof profile, wrongRoot = false) {
  const family = type.startsWith('d') ? 'wordprocessingml' : type.startsWith('x') ? 'spreadsheetml' : 'presentationml';
  const local = wrongRoot ? 'incorrect' : family === 'wordprocessingml' ? 'document' : family === 'spreadsheetml' ? 'workbook' : 'presentation';
  const zip = new JSZip(); zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/custom/main.xml" ContentType="${profile[type]}"/></Types>`);
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="custom/main.xml"/></Relationships>');
  zip.file('custom/main.xml', `<${local} xmlns="http://schemas.openxmlformats.org/${family}/2006/main"/>`); zip.file('custom/unknown.bin', Buffer.from([0, 255, 1, 0]));
  return zip.generateAsync({ type: 'nodebuffer' });
}

it.each(Object.keys(profile) as Array<keyof typeof profile>)('saves original %s bytes through the registered tool and fixed qualifier with Read and Commands Off', async type => {
  const bytes = await packageOf(type); const h = await host(bytes, 'input.' + type);
  const result = await h.tools.run('save_attachment', { asset_id: h.id, path: 'saved.' + type }); expect(result.status, result.output).toBe('success');
  expect(await fs.readFile(join(h.root, 'saved.' + type))).toEqual(bytes);
  expect(result).toMatchObject({ attachmentSave: { code: 'saved', type, receipt: { sha256: sha(bytes), bytes: bytes.length } } });
  expect(h.tools.specs().some(tool => tool.function.name === 'run_command' || tool.function.name === 'read_file')).toBe(false);
  const mismatch = await h.tools.run('save_attachment', { asset_id: h.id, path: 'wrong.txt' }); expect(mismatch.status).toBe('failed');
  expect(mismatch).toMatchObject({ attachmentSave: { code: 'extension-mismatch' } }); await expect(fs.stat(join(h.root, 'wrong.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('qualifies actual generated Word PPTX and XLSX originals, keeping a replaced original as an exact restore point', async () => {
  const word = await host(await officeRouteDocument(), 'placeholder.docx'); word.tools.setDocumentRenderer(await documentRouteRenderer());
  const input = documentInput('docx'); const built = await word.tools.run('write_document', input); expect(built.status, built.output).toBe('success');
  const docx = await fs.readFile(join(word.root, input.path));
  const deck = new PptxGenJS(); deck.addSlide().addText('Actual source slide', { x: 1, y: 1, w: 5, h: 1 }); const pptx = Buffer.from(await deck.write({ outputType: 'nodebuffer' }) as Buffer);
  const xlsx = await typedXlsxFixture();
  for (const [type, bytes] of [['docx', docx], ['pptx', pptx], ['xlsx', xlsx]] as const) {
    const h = await host(bytes, 'actual.' + type); const target = join(h.root, 'saved.' + type); const prior = Buffer.from('Recover this original exactly.'); await fs.writeFile(target, prior);
    const saved = await h.tools.run('save_attachment', { asset_id: h.id, path: 'saved.' + type }); expect(saved.status, saved.output).toBe('success');
    expect(await fs.readFile(target)).toEqual(bytes); expect(saved).toMatchObject({ attachmentSave: { receipt: { created: false, restorePoint: expect.any(String) } } });
    const point = (saved as any).attachmentSave.receipt.restorePoint; expect(await (await h.rawStore()).readBefore(point)).toEqual({ status: 'read', bytes: prior });
  }
});

it.each(['docx', 'pptx', 'xlsx'] as const)('qualifies strict %s roots with a Default-typed main part', async type => {
  const zip = await JSZip.loadAsync(await packageOf(type));
  zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="${profile[type]}"/></Types>`);
  const family = type === 'docx' ? 'wordprocessingml' : type === 'pptx' ? 'presentationml' : 'spreadsheetml';
  zip.file('custom/main.xml', (await zip.file('custom/main.xml')!.async('string')).replace(`http://schemas.openxmlformats.org/${family}/2006/main`, `http://purl.oclc.org/ooxml/${family}/main`));
  const bytes = await zip.generateAsync({ type: 'nodebuffer' }); const h = await host(bytes, 'strict.' + type);
  const result = await h.tools.run('save_attachment', { asset_id: h.id, path: 'saved.' + type }); expect(result.status, result.output).toBe('success');
  expect(await fs.readFile(join(h.root, 'saved.' + type))).toEqual(bytes);
});

it.each(['invalid-zip', 'wrong-root', 'external-main'] as const)('does not save an unqualified %s candidate or trust its filename', async reason => {
  let bytes = reason === 'invalid-zip' ? Buffer.from('PK\x03\x04 not an Office archive') : await packageOf('docx', reason === 'wrong-root');
  if (reason === 'external-main') {
    const zip = await JSZip.loadAsync(bytes); zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="https://invalid.example/no-fetch" TargetMode="External"/></Relationships>'); bytes = await zip.generateAsync({ type: 'nodebuffer' });
  }
  const h = await host(bytes, 'claimed.docx'); const result = await h.tools.run('save_attachment', { asset_id: h.id, path: 'saved.docx' });
  expect(result.status).toBe('failed'); expect(result).toMatchObject({ attachmentSave: { code: 'type-unsupported' } });
  await expect(fs.stat(join(h.root, 'saved.docx'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['revoke', 'stop', 'new-turn', 'write-off'] as const)('writes no original after %s during actual Office qualification', async reason => {
  const h = await host(await officeRouteDocument(), 'source.docx'); const real = h.qualifier.qualify.bind(h.qualifier);
  vi.spyOn(h.qualifier, 'qualify').mockImplementation(async (...args) => {
    const type = await real(...args);
    if (reason === 'revoke') h.tools.setDelegationContentSources([]); else if (reason === 'stop') h.tools.retire(); else if (reason === 'new-turn') h.tools.beginTurn();
    else (h.tools as any).allowed.delete('write'); return type;
  });
  const result = await h.tools.run('save_attachment', { asset_id: h.id, path: 'saved.docx' }); expect(result.status).not.toBe('success');
  await expect(fs.stat(join(h.root, 'saved.docx'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('withholds a parsed Office original when the actual worker returns the wrong source SHA', async () => {
  const h = await host(await officeRouteDocument(), 'source.docx'); h.tools.setOfficeAttachmentQualifier(await officeRouteAttachmentQualifier({ corruptSha: true }));
  const result = await h.tools.run('save_attachment', { asset_id: h.id, path: 'saved.docx' });
  expect(result).toMatchObject({ status: 'failed', attachmentSave: { code: 'type-unsupported' } });
  expect(result.output).toContain('did not match the original attachment');
  await expect(fs.stat(join(h.root, 'saved.docx'))).rejects.toMatchObject({ code: 'ENOENT' });
});
