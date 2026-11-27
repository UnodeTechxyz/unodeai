import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { WorkspaceTools } from '../WorkspaceTools';
import { officeRouteReader, officeRouteEditor, officeRouteDocument } from './officeInventoryRouteFixtures';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';
import { SessionLocalReadScopeConsent } from '../localReadScope';
import { saveHost } from './attachmentSaveFixtures';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { OfficeArtifactHistory, type OfficeArtifactRecord } from '../../office/OfficeArtifactHistory';
import type { OfficeAssetHistorySink } from '../../office/OfficeVisualContracts';

const owned: Array<Awaited<ReturnType<typeof host>>> = [];
afterEach(async () => { for (const h of owned.splice(0)) { h.tools.retire(); await h.reader.dispose(); await h.assets?.dispose(); } await removeTemporaryFolders(); });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function host(allowed = new Set(['read', 'write']), officeHistory?: OfficeAssetHistorySink) {
  const root = await temporaryFolder('unode-office-edit-'); const reader = await officeRouteReader(); const editor = await officeRouteEditor();
  const assets = officeHistory ? new ContentAssetStore({ officeHistory }) : undefined;
  const parameters: ConstructorParameters<typeof WorkspaceTools> = [root, allowed, 'agent']; parameters[22] = assets;
  const tools = new WorkspaceTools(...parameters); tools.setOfficeReader(reader); tools.setOfficeEditor(editor); tools.setOfficeAuthoring(() => ({ trackChangesDefault: false, authorName: '', memberName: 'agent' })); tools.beginTurn();
  const value = { root, reader, editor, tools, assets }; owned.push(value); return value;
}
async function inspect(h: Awaited<ReturnType<typeof host>>, path: string) {
  const result = await h.tools.run('inspect_office', { path }); expect(result.status, result.output).toBe('success'); return JSON.parse(result.output).snapshot_ref as string;
}
const input = (snapshot: string, path = 'edited.docx', ref = 'D1', find = 'Actual Office 名称', replacement = 'Changed\n名称\tresult') => ({
  schema_version: 1, snapshot_ref: snapshot, path, edits: [{ op: 'replace_text', target_ref: ref, find, replace: replacement }],
});
async function assertPreserved(before: Buffer, after: Buffer, changed: string[]) {
  const source = await JSZip.loadAsync(before); const result = await JSZip.loadAsync(after);
  expect(Object.keys(source.files).filter(name => !source.files[name].dir).sort()).toEqual(Object.keys(result.files).filter(name => !result.files[name].dir).sort());
  for (const [name, entry] of Object.entries(source.files)) if (!entry.dir && !changed.includes(name)) {
    expect(hash(await result.file(name)!.async('nodebuffer')), name).toBe(hash(await entry.async('nodebuffer')));
  }
  return result;
}

it('records actual edit source and saved output versions without claiming unsupported preservation checks', async () => {
  const records: OfficeArtifactRecord[] = [];
  const history = new OfficeArtifactHistory({ failed: vi.fn(), write: async (_key, record) => { records.push(record); } });
  const h = await host(undefined, history); const original = await officeRouteDocument();
  await fs.writeFile(join(h.root, 'source.docx'), original);
  const snapshot = await inspect(h, 'source.docx');
  const saved = await h.tools.run('edit_office', input(snapshot)); expect(saved.status, saved.output).toBe('success');
  const output = await fs.readFile(join(h.root, 'edited.docx')); await history.flush();
  const files = records.filter(record => record.kind === 'file'); expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({ format: 'docx', effect: 'created', data: [] });
  expect(files[0].derivations).toContainEqual({ fromSha256: hash(original), toSha256: hash(output), kind: 'edit-source' });
  expect(files[0].versions).toContainEqual({ sha256: hash(output), bytes: output.length, kind: 'office-output' });
  expect(JSON.stringify(records)).not.toContain('physical_key'); expect(JSON.stringify(records)).not.toContain(h.root);
});
it('registered edit_office creates a verified Word copy and replaces in place through the actual write/readback boundary', async () => {
  const h = await host(); const bytes = await officeRouteDocument(); const path = join(h.root, 'source.docx'); await fs.writeFile(path, bytes);
  const snapshot = await inspect(h, 'source.docx'); expect(h.tools.specs().some(spec => spec.function.name === 'edit_office')).toBe(true);
  const result = await h.tools.run('edit_office', input(snapshot)); expect(result.status, result.output).toBe('success');
  expect(result).toMatchObject({ officeEdit: { code: 'written', targetEffect: 'written', receipt: { sourceSha256: hash(bytes) } } });
  const output = await fs.readFile(join(h.root, 'edited.docx')); const zip = await assertPreserved(bytes, output, ['word/document.xml']);
  const xml = await zip.file('word/document.xml')!.async('string'); expect(xml).toContain('Changed'); expect(xml).toContain('<w:br xmlns:w='); expect(xml).toContain('<w:tab xmlns:w=');
  expect(await fs.readFile(path)).toEqual(bytes); expect(result.output).toContain(hash(output)); expect(result.output).toContain('Native visual checks and field/TOC refresh not performed');
  const inPlace = await h.tools.run('edit_office', input(snapshot, 'source.docx')); expect(inPlace.status, inPlace.output).toBe('success');
  await assertPreserved(bytes, await fs.readFile(path), ['word/document.xml']);
  const old = await h.tools.run('edit_office', input(snapshot, 'stale.docx')); expect(old.status).toBe('failed'); expect(old.output).toContain('Source bytes changed');
  await expect(fs.stat(join(h.root, 'stale.docx'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves real PPT notes/chart/embedding/theme/unknown parts and converts a POTX copy to PPTX', async () => {
  const h = await host(); const deck = new PptxGenJS(); const slide = deck.addSlide();
  slide.addText([{ text: 'Old ', options: { bold: true } }, { text: 'title', options: { italic: true } }], { x: 1, y: 1, w: 5, h: 1 }); slide.addNotes('Original notes.');
  slide.addChart(deck.ChartType.bar, [{ name: 'Data', labels: ['Q1'], values: [12] }], { x: 1, y: 2, w: 5, h: 3 });
  deck.addSlide().addText('Untouched second slide.', { x: 1, y: 1, w: 5, h: 1 }); const zip = await JSZip.loadAsync(await deck.write({ outputType: 'nodebuffer' }));
  zip.file('custom/unknown.bin', Buffer.from([0, 255, 7, 12]));
  const types = await zip.file('[Content_Types].xml')!.async('string'); zip.file('[Content_Types].xml', types.replace('presentationml.presentation.main+xml', 'presentationml.template.main+xml'));
  const source = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }); await fs.writeFile(join(h.root, 'template.potx'), source);
  const snapshot = await inspect(h, 'template.potx'); const result = await h.tools.run('edit_office', input(snapshot, 'copy.pptx', 'S1-O1', 'Old title', 'New\nTitle'));
  expect(result.status, result.output).toBe('success'); const output = await fs.readFile(join(h.root, 'copy.pptx'));
  const checked = await assertPreserved(source, output, ['[Content_Types].xml', 'ppt/slides/slide1.xml']);
  expect(await checked.file('[Content_Types].xml')!.async('string')).toContain('presentationml.presentation.main+xml');
  expect(await checked.file('ppt/slides/slide1.xml')!.async('string')).toContain('<a:br xmlns:a='); expect(result.output).toContain('Template copied as a regular');
  const readback = await h.tools.run('inspect_office', { path: 'copy.pptx' }); expect(readback.status).toBe('success'); expect(JSON.parse(readback.output).summary.template).toBe(false);
  expect(await fs.readFile(join(h.root, 'template.potx'))).toEqual(source);
});

it('edits a content-controlled Word cell without changing its same-text neighbour', async () => {
  const h = await host(); const zip = await JSZip.loadAsync(await officeRouteDocument()); const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  zip.file('word/document.xml', `<w:document xmlns:w="${W}"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>same</w:t></w:r></w:p></w:tc><w:sdt><w:sdtContent><w:tc><w:p><w:r><w:t>same</w:t></w:r></w:p></w:tc></w:sdtContent></w:sdt></w:tr></w:tbl></w:body></w:document>`);
  await fs.writeFile(join(h.root, 'source.docx'), await zip.generateAsync({ type: 'nodebuffer' })); const snapshot = await inspect(h, 'source.docx');
  const result = await h.tools.run('edit_office', input(snapshot, 'cell.docx', 'T1-R1-C2', 'same', 'changed')); expect(result.status, result.output).toBe('success');
  const readback = await h.tools.run('inspect_office', { path: 'cell.docx' }); const cells = JSON.parse(readback.output).prepared_fragments.filter((item: any) => item.kind === 'table-cell');
  expect(cells.map((item: any) => item.record.text)).toEqual(['same', 'changed']);
});

it.each(['complex-field', 'simple-field', 'footnote', 'drawing', 'no-break-hyphen', 'ppt-field', 'word-equation', 'word-alternate', 'ppt-alternate'] as const)(
  'preserves %s boundaries through registered edit_office and permits adjacent text', async kind => {
    const h = await host(); const ppt = kind.startsWith('ppt-'); const extension = ppt ? 'pptx' : 'docx';
    const part = ppt ? 'ppt/slides/slide1.xml' : 'word/document.xml'; let zip: JSZip; let boundaryMarkup: string;
    if (ppt) {
      const deck = new PptxGenJS(); deck.addSlide().addText('PLACEHOLDER', { x: 1, y: 1, w: 5, h: 1 });
      zip = await JSZip.loadAsync(await deck.write({ outputType: 'nodebuffer' }));
      const original = await zip.file(part)!.async('string');
      boundaryMarkup = kind === 'ppt-field' ? '<a:fld id="{00000000-0000-0000-0000-000000000001}" type="slidenum"><a:t>3</a:t></a:fld>'
        : '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"><mc:Choice Requires="a14"><a14:m><m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>E=mc²</m:t></m:r></m:oMath></a14:m></mc:Choice><mc:Fallback/></mc:AlternateContent>';
      const paragraph = `<a:p><a:r><a:t>Slide </a:t></a:r>${boundaryMarkup}<a:r><a:t>: Revenue</a:t></a:r></a:p>`;
      const xml = original.replace(/<a:p>[\s\S]*?<\/a:p>/, paragraph); expect(xml).not.toBe(original); zip.file(part, xml);
    } else {
      zip = await JSZip.loadAsync(await officeRouteDocument());
      boundaryMarkup = kind === 'complex-field'
        ? '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> SEQ Figure </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
        : kind === 'simple-field' ? '<w:fldSimple w:instr="SEQ Figure"><w:r><w:t>3</w:t></w:r></w:fldSimple>'
          : kind === 'word-equation' ? '<m:oMath><m:r><m:t>E=mc²</m:t></m:r></m:oMath>'
            : kind === 'word-alternate' ? '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing/></mc:Choice><mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent></w:r>'
              : `<w:r>${kind === 'footnote' ? '<w:footnoteReference w:id="1"/>' : kind === 'drawing' ? '<w:drawing/>' : '<w:noBreakHyphen/>'}</w:r>`;
      zip.file(part, `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><w:body><w:p><w:r><w:t>Figure </w:t></w:r>${boundaryMarkup}<w:r><w:t>: Revenue</w:t></w:r></w:p></w:body></w:document>`);
    }
    const source = await zip.generateAsync({ type: 'nodebuffer' }); const sourceName = `source.${extension}`;
    await fs.writeFile(join(h.root, sourceName), source); const snapshot = await inspect(h, sourceName); const ref = ppt ? 'S1-O1' : 'D1';
    const hasField = kind.includes('field'); const prefix = ppt ? 'Slide ' : 'Figure '; const fieldText = hasField ? '3' : '';
    const blockedPath = `blocked.${extension}`;
    const blocked = await h.tools.run('edit_office', input(snapshot, blockedPath, ref, `${prefix}${fieldText}: Revenue`, 'New caption'));
    expect(blocked).toMatchObject({ status: 'failed', officeEdit: { code: 'text-match-crosses-structural-control' } });
    expect(blocked.output).toContain('field or inline-object boundary');
    await expect(fs.stat(join(h.root, blockedPath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(join(h.root, sourceName))).toEqual(source);
    const adjacentPath = `adjacent.${extension}`;
    const adjacentInput = input(snapshot, adjacentPath, ref, prefix, 'Label ');
    adjacentInput.edits.push({ op: 'replace_text', target_ref: ref, find: ': Revenue', replace: ': Sales' });
    const adjacent = await h.tools.run('edit_office', adjacentInput);
    expect(adjacent.status, adjacent.output).toBe('success');
    const adjacentZip = await assertPreserved(source, await fs.readFile(join(h.root, adjacentPath)), [part]);
    const edited = await adjacentZip.file(part)!.async('string');
    expect(edited).toContain('Label '); expect(edited).toContain(': Sales'); expect(edited).not.toContain(`>${prefix}<`);
    const beforeXml = await zip.file(part)!.async('string');
    expect(beforeXml).toContain(boundaryMarkup); expect(edited).toContain(boundaryMarkup);
    if (hasField) {
      const withinPath = `field-result.${extension}`;
      const within = await h.tools.run('edit_office', input(snapshot, withinPath, ref, '3', '4')); expect(within.status, within.output).toBe('success');
      const fieldZip = await assertPreserved(source, await fs.readFile(join(h.root, withinPath)), [part]);
      expect(await fieldZip.file(part)!.async('string')).toContain('>4<');
    }
  });

it('preserves explicit Read/Write Off and request custody, and refuses raw XML operations before the editor', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'source.docx'), await officeRouteDocument()); const snapshot = await inspect(h, 'source.docx');
  const editor = vi.spyOn(h.editor, 'edit'); const raw = await h.tools.run('edit_office', { ...input(snapshot), edits: [{ op: 'xml', target_ref: 'D1', xml: '<evil/>' }] });
  expect(raw.status).toBe('failed'); expect(editor).not.toHaveBeenCalled();
  const wrongOperation = await h.tools.run('edit_office', { ...input(snapshot), edits: [{ ...input(snapshot).edits[0], op: 'xml' }] });
  expect(wrongOperation.status).toBe('failed'); expect(editor).not.toHaveBeenCalled(); h.tools.beginTurn();
  expect((await h.tools.run('edit_office', input(snapshot))).output).toContain('not held'); expect(editor).not.toHaveBeenCalled();
  const off = await host(new Set(['write'])); expect(off.tools.specs().some(spec => spec.function.name === 'edit_office')).toBe(false);
  expect((await off.tools.run('edit_office', input(snapshot))).status).toBe('refused');
  const noWrite = await host(new Set(['read'])); expect((await noWrite.tools.run('edit_office', input(snapshot))).status).toBe('refused');
});

it('does not borrow another agent’s inspected snapshot through a mismatched host read provider', async () => {
  const h = await host(new Set(['read'])); await fs.writeFile(join(h.root, 'source.docx'), await officeRouteDocument()); const snapshot = await inspect(h, 'source.docx');
  const writer = new WorkspaceTools(h.root, new Set(['write']), 'different-agent'); writer.setOfficeEditor(h.editor); writer.setOfficeAuthoring(() => ({ trackChangesDefault: false, authorName: '', memberName: 'agent' })); writer.setWorkbookReadAuthorityProvider(() => h.tools); writer.beginTurn();
  const edit = vi.spyOn(h.editor, 'edit');
  try {
    expect(await writer.run('edit_office', input(snapshot))).toMatchObject({ status: 'refused', reason: 'capability' }); expect(edit).not.toHaveBeenCalled();
    await expect(fs.stat(join(h.root, 'edited.docx'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { writer.retire(); }
});

it.each(['source-change', 'source-grant-revoked', 'source-stopped'] as const)('writes no output after %s while the actual fixed editor prepares bytes', async failure => {
  const h = await host(); const outside = await temporaryFolder('unode-office-edit-grant-'); const path = join(outside, 'source.docx'); const source = await officeRouteDocument(); await fs.writeFile(path, source);
  const grants = new SessionLocalReadScopeConsent(async () => false); const grant = await grants.requestPathAccess(path, { requestId: 'edit-request', isCurrent: () => true }, async () => ({ permission: 'read', lifetime: 'request' }));
  h.tools.setLivePathAccess(() => grants.pathAccessFor('edit-request')); const snapshot = await inspect(h, path);
  const real = h.editor.edit.bind(h.editor); vi.spyOn(h.editor, 'edit').mockImplementation(async (...args) => {
    const result = await real(...args); if (failure === 'source-change') await fs.writeFile(path, Buffer.from('Changed source bytes'));
    else if (failure === 'source-grant-revoked') grants.revokePathAccess(grant!.id); else h.tools.retire(); return result;
  });
  const result = await h.tools.run('edit_office', input(snapshot)); expect(result.status, result.output).not.toBe('success');
  await expect(fs.stat(join(h.root, 'edited.docx'))).rejects.toMatchObject({ code: 'ENOENT' });
  if (failure !== 'source-change') expect(await fs.readFile(path)).toEqual(source);
});

it.each(['proceed', 'stopped'] as const)('holds the actual Office edit at the request boundary until %s', async decision => {
  const h = await host(); await fs.writeFile(join(h.root, 'source.docx'), await officeRouteDocument()); const snapshot = await inspect(h, 'source.docx');
  let answer: ((result: 'proceed' | 'stopped') => void) | undefined; const calls: string[] = [];
  h.tools.setRequestBoundary(async (_kind, detail) => { calls.push(detail?.tool ?? ''); return new Promise(resolve => { answer = resolve; }); });
  const running = h.tools.run('edit_office', input(snapshot)); await vi.waitFor(() => expect(answer).toBeDefined());
  await expect(fs.stat(join(h.root, 'edited.docx'))).rejects.toMatchObject({ code: 'ENOENT' }); expect(calls).toEqual(['edit_office']);
  answer!(decision); const result = await running;
  if (decision === 'stopped') { expect(result).toMatchObject({ status: 'refused', reason: 'safety-limit' }); await expect(fs.stat(join(h.root, 'edited.docx'))).rejects.toMatchObject({ code: 'ENOENT' }); }
  else { expect(result.status, result.output).toBe('success'); expect((await fs.stat(join(h.root, 'edited.docx'))).size).toBeGreaterThan(0); }
});

it('withholds a worker result whose actual bytes do not match its declared output hash', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'source.docx'), await officeRouteDocument()); const snapshot = await inspect(h, 'source.docx'); const real = h.editor.edit.bind(h.editor);
  vi.spyOn(h.editor, 'edit').mockImplementation(async (...args) => ({ ...await real(...args), sha256: '0'.repeat(64) }));
  const result = await h.tools.run('edit_office', input(snapshot)); expect(result.status).toBe('failed'); expect(result).toMatchObject({ officeEdit: { code: 'office-output-check-failed', targetEffect: 'none' } });
  await expect(fs.stat(join(h.root, 'edited.docx'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps exact source ZIP bytes as a real restore point before an in-place Office edit', async () => {
  const effects: any[] = []; const h = await saveHost({ onEffect: effect => effects.push(effect) }); const reader = await officeRouteReader(); const editor = await officeRouteEditor();
  const tools = h.tools(); tools.setOfficeReader(reader); tools.setOfficeEditor(editor); tools.setOfficeAuthoring(() => ({ trackChangesDefault: false, authorName: '', memberName: 'agent' })); tools.beginTurn(); const bytes = await officeRouteDocument();
  await fs.writeFile(join(h.root, 'source.docx'), bytes);
  try {
    const snapshot = JSON.parse((await tools.run('inspect_office', { path: 'source.docx' })).output).snapshot_ref;
    const result = await tools.run('edit_office', input(snapshot, 'source.docx')); expect(result.status, result.output).toBe('success');
    const store = await h.rawStore(); const [point] = store.list(); expect(point).toBeDefined();
    expect(result).toMatchObject({ officeEdit: { receipt: { kind: 'office-edited', effect: 'replaced', restorePointId: point.id, sourceSha256: hash(bytes) } } });
    expect(await store.readBefore(point.id)).toEqual({ status: 'read', bytes });
    const written = await fs.readFile(join(h.root, 'source.docx')); expect(hash(written)).not.toBe(hash(bytes));
    expect(effects).toHaveLength(1); expect(effects[0]).toMatchObject({ path: 'source.docx', grade: 'host-verified', requestId: 'r1' });
    const refreshed = JSON.parse((await tools.run('inspect_office', { path: 'source.docx' })).output).snapshot_ref;
    const unchanged = await tools.run('edit_office', input(refreshed, 'source.docx', 'D1', 'Changed', 'Changed'));
    expect(unchanged.status, unchanged.output).toBe('success'); expect(unchanged.output).toContain('Saved unchanged DOCX');
    expect(unchanged).toMatchObject({ officeEdit: { receipt: { effect: 'unchanged' } } });
    expect(unchanged.officeEdit?.receipt).not.toHaveProperty('restorePointId'); expect(await fs.readFile(join(h.root, 'source.docx'))).toEqual(written);
    expect(store.list()).toHaveLength(1); expect(effects).toHaveLength(1);
  } finally { tools.retire(); await reader.dispose(); await h.assets.dispose(); }
});

it('converts a default-typed Word template by adding the actual main-part override', async () => {
  const h = await host(); const zip = await JSZip.loadAsync(await officeRouteDocument());
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' }); await fs.writeFile(join(h.root, 'template.dotx'), bytes);
  const snapshot = await inspect(h, 'template.dotx'); const result = await h.tools.run('edit_office', input(snapshot, 'from-template.docx'));
  expect(result.status, result.output).toBe('success'); const output = await assertPreserved(bytes, await fs.readFile(join(h.root, 'from-template.docx')), ['[Content_Types].xml', 'word/document.xml']);
  expect(await output.file('[Content_Types].xml')!.async('string')).toContain('wordprocessingml.document.main+xml');
  const checked = await h.tools.run('inspect_office', { path: 'from-template.docx' }); expect(checked.status).toBe('success'); expect(JSON.parse(checked.output).summary.template).toBe(false);
});

it('does not overwrite a newer source changed during actual restore-point capture', async () => {
  let replace: (() => Promise<void>) | undefined; const h = await saveHost({ duringCapture: async () => { await replace?.(); } });
  const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const tools = h.tools(); tools.setOfficeReader(reader); tools.setOfficeEditor(editor); tools.setOfficeAuthoring(() => ({ trackChangesDefault: false, authorName: '', memberName: 'agent' })); tools.beginTurn();
  const bytes = await officeRouteDocument(); const path = join(h.root, 'source.docx'); await fs.writeFile(path, bytes);
  try {
    const snapshot = JSON.parse((await tools.run('inspect_office', { path: 'source.docx' })).output).snapshot_ref;
    const newer = Buffer.from('Newer source owned by another edit'); replace = async () => { await fs.writeFile(path, newer); };
    const result = await tools.run('edit_office', input(snapshot, 'source.docx')); expect(result.status, result.output).toBe('failed');
    expect(result).toMatchObject({ officeEdit: { targetEffect: 'none' } }); expect(await fs.readFile(path)).toEqual(newer);
  } finally { tools.retire(); await reader.dispose(); await h.assets.dispose(); }
});
