import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import JSZip from 'jszip';
import { WorkspaceTools } from '../WorkspaceTools';
import { CommandPolicy } from '../CommandPolicy';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { OfficeArtifactHistory, type OfficeArtifactRecord } from '../../office/OfficeArtifactHistory';
import { OfficeReader } from '../../office/OfficeReader';
import { NativeOfficeRenderer } from '../../office/NativeOfficeRenderer';
import { OfficeRenderPureHost } from '../../office/OfficeRenderPureHost';
import { WINDOWS_OFFICE_RENDER_SCRIPT } from '../../office/WindowsOfficeScript';
import { EXPORT_PDF_SPEC, EXPORT_PDF_TOOL } from '../../office/OfficeExportTool';
import type { PdfEditor } from '../../office/pdf/PdfEditor';
import type { WindowsPowerShellDocumentRequest, WindowsPowerShellDocumentResult } from '../../host/windowsPowerShell';
import { makePdf, sha, textPort } from '../../office/pdf/__tests__/pdfFixtures';
import { officeRouteDocument, officeRouteEditor, officeRouteReader } from './officeInventoryRouteFixtures';
import { pdfRouteEditor } from './pdfRouteFixtures';
import { temporaryFolder, removeTemporaryFolders } from './pathSafetyFixtures';

// P4b (D12, 13.10) through the real host entries: inspect_office, export_pdf, edit_office (tracked by default), edit_pdf
// and the common write boundary with a real OfficeArtifactHistory. Only the native helper transport and the executable
// lookup are fixtures: the fake helper writes a real PDF (its text names the export) where Word would.
const lookup = vi.hoisted(() => ({ executable: '' }));
vi.mock('../../security/HostExecutableResolver', async importOriginal => ({ ...await importOriginal<any>(), resolveHostExecutable: () => lookup.executable }));
let worker: string; let reader: Awaited<ReturnType<typeof officeRouteReader>>; let pdfEditor: PdfEditor;
const owned: WorkspaceTools[] = []; const stores: ContentAssetStore[] = [];
beforeAll(async () => {
  reader = await officeRouteReader(); pdfEditor = await pdfRouteEditor();
  worker = join(dirname((reader as any).worker), 'OfficeRenderPureWorker.cjs');
  await build({ entryPoints: ['src/office/OfficeRenderPureWorker.ts'], outfile: worker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
});
afterEach(async () => { for (const tools of owned.splice(0)) { tools.retire(); await tools.disposeBackground(); } for (const store of stores.splice(0)) await store.dispose(); vi.unstubAllEnvs(); });
afterAll(async () => { await reader.dispose(); await removeTemporaryFolders(); });

async function host() {
  const root = await temporaryFolder('unode-pdf-source-route-');
  lookup.executable = join(root, 'fixed-powershell.exe'); await fs.writeFile(lookup.executable, 'inert interpreter fixture'); vi.stubEnv('SystemRoot', root);
  const records: OfficeArtifactRecord[] = [];
  const history = new OfficeArtifactHistory({ failed: vi.fn(), write: async (_key, record) => { records.push(record); }, saved: () => records });
  const assets = new ContentAssetStore({ officeHistory: history }); stores.push(assets);
  const parameters: ConstructorParameters<typeof WorkspaceTools> = [root, new Set(['read', 'write', 'execute']), 'agent'];
  parameters[4] = new CommandPolicy('all', []); parameters[5] = 120000; parameters[22] = assets;
  const tools = new WorkspaceTools(...parameters); owned.push(tools);
  tools.setOfficeReader(new OfficeReader((reader as any).worker)); tools.setOfficeEditor(await officeRouteEditor()); tools.setPdfEditor(pdfEditor);
  tools.setOfficeAuthoring(() => ({ trackChangesDefault: true, authorName: '', memberName: 'agent' }));
  let exports = 0;
  const execute = vi.fn(async (request: WindowsPowerShellDocumentRequest): Promise<WindowsPowerShellDocumentResult> => {
    expect(Buffer.from(request.encodedCommand, 'base64').toString('utf16le')).toBe(WINDOWS_OFFICE_RENDER_SCRIPT);
    const job = JSON.parse(Buffer.from(request.input, 'base64').toString());
    await fs.writeFile(job.pdf, await makePdf([{ text: `Contract export ${++exports}` }]));
    return { status: 'exited', code: 0, signal: null, stderr: '', stdout: JSON.stringify({ version: 1, operation_id: job.operationId, status: 'passed', page_count: 0,
      completed_pages: 0, document_closed: true, app_version: '16.0', native_app: 'quit-by-helper', stage_released: true }) };
  });
  tools.useNativeOfficeRenderer(new NativeOfficeRenderer({ platform: 'win32', pure: new OfficeRenderPureHost(worker), execute,
    catalog: { candidate: vi.fn(async (id: 'word' | 'powerpoint' | 'libreoffice') => ({ id, path: join(root, 'inert-' + id + '.exe'), sha256: 'a'.repeat(64), bytes: 1 })) } }));
  tools.beginTurn();
  const inspect = async (path: string) => {
    const inspected = await tools.run('inspect_office', { path }); expect(inspected.status, inspected.output).toBe('success'); return JSON.parse(inspected.output).snapshot_ref as string;
  };
  const exportPdf = async (path: string, snapshot: string, regenerates?: object) => {
    const outcome = await tools.run(EXPORT_PDF_TOOL, { snapshot_ref: snapshot, path, adapter_id: 'word', ...(regenerates ? { regenerates_pdf: regenerates } : {}) });
    expect(outcome.status, outcome.output).toBe('success'); return JSON.parse(outcome.output);
  };
  return { root, tools, history, execute, inspect, exportPdf };
}
const pageTexts = async (bytes: Uint8Array) => (await textPort.pages(bytes)).map(items => items.map(item => item.str).join(''));

it('source DOCX route: export, combine, tracked edit of the DOCX, re-export confirmed as from that source, replace_pages', async () => {
  const h = await host(); const original = await officeRouteDocument(); await fs.writeFile(join(h.root, 'contract.docx'), original);
  await fs.writeFile(join(h.root, 'annex.pdf'), await makePdf([{ text: 'Annex page' }]));
  const first = await h.exportPdf('contract.pdf', await h.inspect('contract.docx'));
  expect(first).toMatchObject({ kind: 'pdf-exported', source_sha256: sha(original) }); expect(first.source_lineage).toBeUndefined();
  const packet = await h.tools.run('edit_pdf', { schema_version: 1, destination: 'packet.pdf', inputs: [{ path: 'contract.pdf' }, { path: 'annex.pdf' }],
    operations: [{ op: 'merge' }, { op: 'add_page_numbers' }] });
  expect(packet.status, packet.output).toBe('success');
  // The Word edit is tracked by default; the DOCX is edited in place.
  const edited = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: await h.inspect('contract.docx'), path: 'contract.docx',
    edits: [{ op: 'replace_text', target_ref: 'D1', find: 'Actual Office 名称', replace: 'Revised term' }] });
  expect(edited.status, edited.output).toBe('success');
  const revised = await fs.readFile(join(h.root, 'contract.docx')); expect(sha(revised)).not.toBe(sha(original));
  const packetBytes = await fs.readFile(join(h.root, 'packet.pdf'));
  const second = await h.exportPdf('contract-v2.pdf', await h.inspect('contract.docx'), { path: 'packet.pdf' });
  expect(second).toMatchObject({ kind: 'pdf-exported', source_sha256: sha(revised),
    source_lineage: { regenerates: 'packet.pdf', pdf_sha256: sha(packetBytes), state: 'confirmed-source', note: expect.stringContaining('Re-exported from the source document') } });
  expect(await fs.readFile(join(h.root, 'contract.docx'))).toEqual(revised); expect(await fs.readFile(join(h.root, 'packet.pdf'))).toEqual(packetBytes);
  // The combined PDF takes the new contract page; the annex stays.
  const replaced = await h.tools.run('edit_pdf', { schema_version: 1, destination: 'final.pdf', inputs: [{ path: 'packet.pdf' }],
    operations: [{ op: 'replace_pages', pages: '1', from: { path: 'contract-v2.pdf' } }, { op: 'add_page_numbers', pages: '1' }] });
  expect(replaced.status, replaced.output).toBe('success');
  const pages = await pageTexts(await fs.readFile(join(h.root, 'final.pdf')));
  expect(pages).toHaveLength(2); expect(pages[0]).toContain('Contract export 2'); expect(pages[1]).toContain('Annex page');
});

it('a document UnodeAi never exported that PDF from is exported, and the receipt says the source is not confirmed', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'contract.docx'), await officeRouteDocument());
  await h.exportPdf('contract.pdf', await h.inspect('contract.docx'));
  const zip = await JSZip.loadAsync(await officeRouteDocument()); zip.file('docProps/custom.xml', '<unrelated/>');
  await fs.writeFile(join(h.root, 'other.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const receipt = await h.exportPdf('other.pdf', await h.inspect('other.docx'), { path: 'contract.pdf' });
  expect(receipt.source_lineage).toMatchObject({ regenerates: 'contract.pdf', state: 'not-confirmed', note: expect.stringContaining('not confirmed') });
  expect(await fs.readFile(join(h.root, 'other.pdf'))).toBeTruthy();
});

it('a DOCX changed outside UnodeAi after UnodeAi wrote it is still confirmed by its recorded earlier version at that file', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'contract.docx'), await officeRouteDocument());
  const edited = await h.tools.run('edit_office', { schema_version: 1, snapshot_ref: await h.inspect('contract.docx'), path: 'contract.docx',
    edits: [{ op: 'replace_text', target_ref: 'D1', find: 'Actual Office 名称', replace: 'Agreed term' }] });
  expect(edited.status, edited.output).toBe('success');
  await h.exportPdf('contract.pdf', await h.inspect('contract.docx'));
  // Edited elsewhere: no UnodeAi edge leads to these bytes, but this same file had the exported version.
  const outside = await JSZip.loadAsync(await fs.readFile(join(h.root, 'contract.docx')));
  outside.file('docProps/custom.xml', '<changed-outside/>'); await fs.writeFile(join(h.root, 'contract.docx'), await outside.generateAsync({ type: 'nodebuffer' }));
  const receipt = await h.exportPdf('contract-v2.pdf', await h.inspect('contract.docx'), { path: 'contract.pdf' });
  expect(receipt.source_lineage).toMatchObject({ state: 'confirmed-source' });
});

it('an earlier PDF that cannot be read is reported as not checked and never blocks the export', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'contract.docx'), await officeRouteDocument());
  const receipt = await h.exportPdf('contract.pdf', await h.inspect('contract.docx'), { path: 'missing.pdf' });
  expect(receipt.source_lineage).toMatchObject({ regenerates: 'missing.pdf', state: 'not-confirmed', note: expect.stringContaining('could not be checked') });
  await fs.writeFile(join(h.root, 'notes.pdf'), 'not a pdf');
  const second = await h.exportPdf('contract-2.pdf', await h.inspect('contract.docx'), { path: 'notes.pdf' });
  expect(second.source_lineage).toMatchObject({ state: 'not-confirmed', note: expect.stringContaining('not a PDF') });
  expect(h.execute).toHaveBeenCalledTimes(2);
});

it('a malformed regenerates_pdf is an input error and starts nothing', async () => {
  const h = await host(); await fs.writeFile(join(h.root, 'contract.docx'), await officeRouteDocument());
  const snapshot = await h.inspect('contract.docx');
  for (const regenerates_pdf of [{ path: 'a.pdf', source_ref: 'content-1' }, {}, { path: ' ' }, 'a.pdf', { file: 'a.pdf' }]) {
    const outcome = await h.tools.run(EXPORT_PDF_TOOL, { snapshot_ref: snapshot, path: 'x.pdf', adapter_id: 'word', regenerates_pdf });
    expect(outcome.status).toBe('failed'); expect(outcome.output).toContain('regenerates_pdf');
  }
  expect(h.execute).not.toHaveBeenCalled();
  expect(Object.keys((EXPORT_PDF_SPEC.function.parameters.properties as Record<string, unknown>))).toContain('regenerates_pdf');
});
