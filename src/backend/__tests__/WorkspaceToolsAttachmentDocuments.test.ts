import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { attachment, saveHost, sha } from './attachmentSaveFixtures';
import { userTurnSources } from '../../host/orchestration/OrchestrationHostAdapter';
import { composeUserTextAttachments } from '../../attachments';
import { officeRouteDocument, officeRouteEditor, officeRouteReader } from './officeInventoryRouteFixtures';
import { workbookRouteReader } from './workbookRouteFixtures';
import { typedXlsxFixture } from '../../content/__tests__/xlsxFixtures';
import { COMPUTE_CSV, workbookSumPlan, WorkbookRecordCollector } from './workbookComputeFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';
import { compileTaskContract, TaskInputResolver } from '../TaskContract';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); await removeTemporaryFolders(); });
async function host(name: string, bytes: Buffer, allowed: Array<'read' | 'write'> = ['read', 'write']) {
  const h = await saveHost({ capabilities: allowed }); const office = await officeRouteReader(); const editor = await officeRouteEditor(); const workbook = await workbookRouteReader();
  const item = attachment(name, 'application/octet-stream', 'file', bytes);
  const { delegationContentSources: sources } = await userTurnSources(h.assets, { text: 'Read it.', expanded: 'Read it.', mentions: [], userAttachments: [item] });
  h.assets.holdForUserRequest('agent', sources.map(source => source.assetId));
  const tools = h.tools('agent', sources); tools.setOfficeReader(office); tools.setOfficeEditor(editor); tools.setWorkbookReader(workbook); tools.beginTurn();
  cleanups.push(async () => { tools.retire(); await office.dispose(); await workbook.dispose(); await h.assets.dispose(); });
  const ref = item.contentAssetId!; expect(ref).toMatch(/^content-/); return { ...h, tools, item, ref, sources, office, editor, workbook };
}
const edit = (snapshot: string) => ({ schema_version: 1, snapshot_ref: snapshot, path: 'copy.docx', edits: [
  { op: 'replace_text', target_ref: 'D1', find: 'Actual Office 名称', replace: 'Attachment result' },
] });

it('admits original Office bytes and edits their source_ref without inventing a workspace source path', async () => {
  const bytes = await officeRouteDocument(); const h = await host('contract.DOCX', bytes);
  const carrier = composeUserTextAttachments([h.item]); expect(carrier.inlined).toEqual([]); expect(carrier.addressed).toEqual([h.item]);
  expect(carrier.text).toContain(h.ref); expect(carrier.text).toContain('Contents have not been shown'); expect(carrier.text).not.toContain('Actual Office 名称');
  expect(h.assets.getReceipt(h.ref)).toMatchObject({ mediaKind: 'binary', byteLength: bytes.length, mimeType: 'application/octet-stream' });
  const read = vi.spyOn((h.tools as any).coordinator, 'recordRead');
  const result = await h.tools.run('inspect_office', { source_ref: h.ref }); expect(result.status, result.output).toBe('success');
  const page = JSON.parse(result.output); expect(page.kind).toBe('docx'); expect(page.source_sha256).toBe(sha(bytes)); expect(result.output).not.toContain('attachment-source-');
  expect(read).not.toHaveBeenCalled(); expect(await fs.readdir(h.root)).toEqual([]);
  const changed = await h.tools.run('edit_office', edit(page.snapshot_ref)); expect(changed.status, changed.output).toBe('success');
  const zip = await JSZip.loadAsync(await fs.readFile(join(h.root, 'copy.docx'))); expect(await zip.file('word/document.xml')!.async('string')).toContain('Attachment result');
  const original = await h.assets.readUserAttachment(h.ref); expect(original).toMatchObject({ status: 'ready', sha256: sha(bytes) });
  if (original.status === 'ready') expect(original.bytes).toEqual(bytes);
});

it('reads the actual attached XLSX and transforms original attached CSV bytes', async () => {
  const xlsxBytes = await typedXlsxFixture(); const xlsx = await host('data.xlsx', xlsxBytes);
  const result = await xlsx.tools.run('read_workbook', { source_ref: xlsx.ref, operation: 'range', range: 'E1:G1' });
  expect(result.status, result.output).toBe('success'); expect(JSON.parse(result.output).source_sha256).toBe(sha(xlsxBytes));
  expect(JSON.parse(result.output).prepared_fragments.map((fragment: any) => fragment.record.value)).toMatchObject([
    { kind: 'number', raw: '0' }, { kind: 'boolean', value: false }, { kind: 'error', code: '#DIV/0!' },
  ]);
  expect(result.output).not.toContain('attachment-source-'); expect(await fs.readdir(xlsx.root)).toEqual([]);
  const invalid = await xlsx.tools.run('read_workbook', { source_ref: xlsx.ref, operation: 'range', range: 'C1:A1' });
  expect(invalid.status).toBe('failed'); expect(invalid.output).toContain('ordered A1 range'); expect(invalid.output).not.toContain('unencrypted');
  const csv = await host('data.csv', Buffer.from(COMPUTE_CSV));
  const inspected = await csv.tools.run('read_workbook', { source_ref: csv.ref }); expect(inspected.status, inspected.output).toBe('success');
  const computed = await csv.tools.run('transform_workbook', workbookSumPlan(JSON.parse(inspected.output).snapshot_ref));
  expect(computed.status, computed.output).toBe('success'); expect(JSON.parse(computed.output).transformation_ref).toMatch(/^transformation-/);
  const records = new WorkbookRecordCollector(); let page = JSON.parse(computed.output);
  for (let count = 0; ; count++) {
    expect(count).toBeLessThan(30); records.add(page); if (!page.next_cursor) break;
    const next = await csv.tools.run('transform_workbook', { operation: 'read', data_ref: page.data_ref, cursor: page.next_cursor });
    expect(next.status, next.output).toBe('success'); page = JSON.parse(next.output);
  }
  const rows = records.records().filter(item => item.kind === 'row').map(item => item.record.cells);
  expect(rows.find(row => row.team.text === 'A').total.exact).toEqual({ numerator: '3', denominator: '10' });
  expect(rows.find(row => row.team.text === 'B').total.exact).toEqual({ numerator: '9007199254740994', denominator: '1' });
  csv.tools.beginTurn();
  const retained = await csv.tools.run('transform_workbook', { operation: 'read', data_ref: page.data_ref });
  expect(retained.status, retained.output).toBe('success');
  csv.tools.setDelegationContentSources([]);
  expect((await csv.tools.run('transform_workbook', { operation: 'read', data_ref: page.data_ref })).status).not.toBe('success');
});

it('checks source_ref custody and exact input choice without granting access by id', async () => {
  const h = await host('source.docx', await officeRouteDocument());
  expect((await h.tools.run('inspect_office', { path: 'unused.docx', source_ref: h.ref })).status).toBe('failed');
  expect((await h.tools.run('inspect_office', { source_ref: 'content-999999' })).output).toContain('unavailable to this agent');
  h.tools.setDelegationContentSources([]);
  expect((await h.tools.run('inspect_office', { source_ref: h.ref })).output).toContain('unavailable to this agent');
  const off = await host('source.docx', await officeRouteDocument(), ['write']);
  expect(await off.tools.run('inspect_office', { source_ref: off.ref })).toMatchObject({ status: 'refused', reason: 'capability' });
});

it.each(['revoke', 'stop', 'corrupt'] as const)('writes no destination after attachment %s during actual editor preparation', async reason => {
  const bytes = await officeRouteDocument(); const h = await host('source.docx', bytes); const inspected = await h.tools.run('inspect_office', { source_ref: h.ref });
  expect(inspected.status, inspected.output).toBe('success'); const real = h.editor.edit.bind(h.editor);
  vi.spyOn(h.editor, 'edit').mockImplementation(async (...args) => {
    const output = await real(...args);
    if (reason === 'revoke') h.tools.setDelegationContentSources([]);
    else if (reason === 'stop') h.tools.retire();
    else await fs.writeFile((h.assets as any).assets.get(h.ref).attached.path, Buffer.alloc(bytes.length, 0x20));
    return output;
  });
  const result = await h.tools.run('edit_office', edit(JSON.parse(inspected.output).snapshot_ref)); expect(result.status).not.toBe('success');
  if (reason === 'corrupt') expect(result.output).toContain('attach the source again');
  await expect(fs.stat(join(h.root, 'copy.docx'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('uses the actual live task input grant for a binary source and loses it when the attempt ends', async () => {
  const h = await host('source.docx', await officeRouteDocument()); const resolver = new TaskInputResolver(h.assets, h.root);
  const text = await h.assets.storeText('Current supplied helper text.', 'turn-supplied');
  const compiled = compileTaskContract({ version: 1, objective: 'Read the supplied document.', expected_deliverable: 'Summary.',
    effects: { read_files: [], expected_file_effect: 'none' }, inputs: [{ input_id: 'source', kind: 'contentAsset', asset_id: h.ref, purpose: 'User source',
      required: true, freshness: 'attempt-start', provenance: { kind: 'user-turn', source_refs: [] } },
    { input_id: 'plain', kind: 'contentAsset', asset_id: text.assetId, purpose: 'Supplied text', required: true, freshness: 'attempt-start', provenance: { kind: 'user-turn', source_refs: [] } }], constraints: [], dependencies: [],
    required_capabilities: { version: 1, capabilities: ['read'] }, execution_strategy: 'delegate-required' }, 'pm');
  expect(compiled.error).toBeUndefined();
  const attempt = await resolver.beginAttempt(compiled.contract!, { agentId: 'agent', capabilities: { read: true, write: false, shell: false },
    taskScope: 'per-turn', verificationSensors: [], authorizedContentAssetIds: [h.ref, text.assetId], liveContentAssetIds: [h.ref, text.assetId], readyArtifacts: [] }, 'pm');
  h.tools.setTaskInputResolver(resolver); h.tools.setTaskAttempt(attempt.card);
  expect((await h.tools.run('inspect_office', { source_ref: text.assetId })).status).toBe('failed');
  expect((await h.tools.run('report_context_gap', { inputId: 'plain' })).status).toBe('failed');
  const plain = await h.tools.run('read_extracted_content', { assetId: text.assetId }); expect(plain.status, plain.output).toBe('success'); expect(plain.output).toContain('Current supplied helper text.');
  expect(resolver.grantsForAttempt(attempt.card!.attemptId)[0].readAt).toBeUndefined();
  const read = await h.tools.run('inspect_office', { source_ref: h.ref }); expect(read.status, read.output).toBe('success');
  expect(resolver.grantsForAttempt(attempt.card!.attemptId)[0].readAt).toEqual(expect.any(String));
  const original = (h.assets as any).assets.get(h.ref).attached; await fs.writeFile(original.path, Buffer.alloc(original.byteLength, 0x20));
  const failed = await h.tools.run('inspect_office', { source_ref: h.ref }); expect(failed.status).toBe('failed');
  const gap = await h.tools.run('report_context_gap', { inputId: 'source' }); expect(gap.status, gap.output).toBe('success'); expect(gap.output).toContain('Context gap recorded');
  resolver.endAttempt(attempt.card!.attemptId, 'cancelled');
  const stopped = await h.tools.run('inspect_office', { source_ref: h.ref }); expect(stopped.status).not.toBe('success'); expect(stopped.output).not.toContain('Actual Office 名称');
});

it('does not publish attachment content if its live Read grant ends after actual worker preparation', async () => {
  const h = await host('source.docx', await officeRouteDocument()); const real = h.office.read.bind(h.office);
  vi.spyOn(h.office, 'read').mockImplementation(async (...args) => { const page = await real(...args); h.tools.setDelegationContentSources([]); return page; });
  const result = await h.tools.run('inspect_office', { source_ref: h.ref }); expect(result.status).toBe('failed'); expect(result.output).not.toContain('Actual Office 名称');
});
