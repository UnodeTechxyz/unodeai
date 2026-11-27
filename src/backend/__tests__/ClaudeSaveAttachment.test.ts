/*
 * v0.9.97 P4: Claude reaches `save_attachment` through its existing files bridge, served by the host's own file tools
 * (review resolution §2 route matrix: "save_attachment ... Claude CLI: exposed through the existing MCP file service
 * as the same host tool"). The bridge's read tools stay read-only; Plan mode, a stopped agent and a coordinator
 * without a contract make no save.
 */
import { EventEmitter } from 'events';
import { existsSync, readdirSync, realpathSync } from 'fs';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeHeadlessBackend } from '../ClaudeHeadlessBackend';
import { SAVE_ATTACHMENT_DESCRIPTION, WorkspaceTools } from '../WorkspaceTools';
import { CommandPolicy } from '../CommandPolicy';
import type { AgentConfig } from '../../types';
import { admitUserTurn, attachment, attachmentIds, PDF, PNG, saveHost, sha } from './attachmentSaveFixtures';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';
import { SessionLocalReadScopeConsent } from '../localReadScope';
import { documentInput, documentRouteRenderer, boundDocumentInput, assertBoundDocument } from './documentRouteFixtures';
import { WRITE_DOCUMENT_SPEC } from '../../content/document/DocumentTool';
import { assertEditablePresentation, presentationInput, presentationRouteRenderer, boundPresentationInput, assertBoundPresentation } from './presentationRouteFixtures';
import { PRESENTATION_PNG, presentationWithImage, assertOriginalPngEmbedded } from './presentationImageFixtures';
import { workbookRouteReader, workbookRouteEditor } from './workbookRouteFixtures';
import { workbookFixture } from '../../office/__tests__/workbookEditFixtures';
import { officeRouteReader, officeRouteEditor, officeRouteDocument, officeRouteParagraph } from './officeInventoryRouteFixtures';
import JSZip from 'jszip';
import type { WorkbookPage } from '../../content/WorkbookPage';
import { COMPUTE_CSV, workbookSumPlan, WorkbookRecordCollector } from './workbookComputeFixtures';
import { pdfRouteEditor } from './pdfRouteFixtures';
import { makePdf, textPort as pdfTextPort } from '../../office/pdf/__tests__/pdfFixtures';

afterEach(removeTemporaryFolders);

function config(dir: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'claude-1', name: 'Claude Dev', role: 'developer', skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' }, model: 'claude-sonnet-4-5',
    systemPrompt: 'Follow the role.', autoApprove: true, allowedTools: ['read', 'write'], backend: 'claude',
    workingDirectory: dir, ...overrides,
  };
}

function fakeSpawn() {
  const calls: Array<{ args: string[] }> = [];
  let spawnedProcess: any;
  const fn = (_cmd: string, args: string[]) => {
    calls.push({ args });
    const proc = new EventEmitter() as any;
    spawnedProcess = proc;
    proc.pid = 1234;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined;
    proc.stderr.setEncoding = () => undefined;
    proc.stdin = { write: () => true, end: () => undefined };
    proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); return true; };
    setTimeout(() => proc.emit('spawn'), 0);
    return proc;
  };
  return { fn, calls, get process() { return spawnedProcess; } };
}

async function filesBridge(dir: string): Promise<{ url: string; headers?: Record<string, string> }> {
  const root = path.join(dir, '.unode', 'claude');
  const [file] = existsSync(root) ? readdirSync(root).map((id) => path.join(root, id, 'mcp.json')).filter(existsSync) : [];
  const written = JSON.parse(await fs.readFile(file, 'utf8'));
  const id = Object.keys(written.mcpServers).find((key) => /^unode_files_[a-f0-9]{32}$/.test(key))!;
  return written.mcpServers[id];
}

function rpc(spec: { url: string; headers?: Record<string, string> }, body: unknown): Promise<any> {
  const url = new URL(spec.url);
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: Number(url.port), path: '/mcp', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), Authorization: String(spec.headers?.Authorization ?? '') },
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (out += chunk));
      res.on('end', () => resolve(out ? JSON.parse(out) : undefined));
    });
    req.on('error', reject);
    req.end(text);
  });
}

const call = (spec: { url: string }, args: Record<string, unknown>) =>
  rpc(spec, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'save_attachment', arguments: args } });

async function claudeWithHostTools(withTools = true) {
  const h = await saveHost();
  const sources = await admitUserTurn(h.assets, [attachment('image.png', 'image/png', 'image', PNG)]);
  const tools = h.tools('claude-1');
  const spawn = fakeSpawn();
  const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, {
    spawn: spawn.fn as any,
    writeRoots: [h.root],
    // As the host passes it: the bridge then exists for its readers, with or without the host tools.
    delegationContentAssets: h.assets,
    ...(withTools ? { hostFileTools: tools } : {}),
  });
  await backend.start({} as NodeJS.ProcessEnv, { pin: 'take' });
  return { h, sources, tools, backend, spawn, id: attachmentIds(sources)[0] };
}

import { typedXlsxFixture } from '../../content/__tests__/xlsxFixtures';
describe('D3 actual Claude files bridge to real document worker', () => {
  it('reads and edits original attachment source_ref bytes through authenticated Claude MCP', async () => {
    const h = await saveHost({ capabilities: ['write'] }); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const bytes = await officeRouteDocument();
    const item = attachment('source.docx', 'application/octet-stream', 'file', bytes); const sources = await admitUserTurn(h.assets, [item]);
    h.assets.holdForUserRequest('claude-1', sources.map(source => source.assetId)); const writer = h.tools('claude-1'); writer.setOfficeEditor(editor);
    const backend = new ClaudeHeadlessBackend(config(h.root, { allowedTools: ['read', 'write'] }), undefined, undefined,
      { spawn: fakeSpawn().fn as any, writeRoots: [h.root], delegationContentAssets: h.assets, hostFileTools: writer });
    await backend.start({}, { pin: 'take' });
    try {
      backend.sendUserTurn('Edit the attachment.', { userAttachments: [item], delegationContentSources: sources });
      await vi.waitFor(() => expect((backend as any).filesBridgeTools).toBeDefined()); (backend as any).filesBridgeTools.setOfficeReader(reader); const spec = await filesBridge(h.root);
      const read = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'inspect_office', arguments: { source_ref: item.contentAssetId } } });
      expect(read.result.isError, JSON.stringify(read)).toBeFalsy(); const snapshot = JSON.parse(read.result.content[0].text).snapshot_ref;
      const edited = await rpc(spec, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'edit_office', arguments: {
        schema_version: 1, snapshot_ref: snapshot, path: 'attachment-copy.docx', edits: [{ op: 'replace_text', target_ref: 'D1', find: 'Actual Office 名称', replace: 'Claude attachment result' }],
      } } });
      expect(edited.result.isError, JSON.stringify(edited)).toBeFalsy(); const zip = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'attachment-copy.docx')));
      expect(await zip.file('word/document.xml')!.async('string')).toContain('Claude attachment result');
      // v0.9.108 W2: the Claude bridge offers the tracked-change field and decision operations, and the default Word edit is tracked.
      const editTool = (await rpc(spec, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).result.tools.find((tool: any) => tool.name === 'edit_office');
      expect(editTool.inputSchema.properties.track_changes.type).toBe('boolean'); expect(editTool.inputSchema.properties.edits.items.properties.op.enum).toEqual(expect.arrayContaining(['accept_revision', 'reject_revision']));
      expect(edited.result.content[0].text).toContain('Tracked changes: recorded as Word revisions');
      expect(writer.specs().some(tool => tool.function.name === 'read_file')).toBe(false);
    } finally { await backend.stop(50); await reader.dispose(); await h.assets.dispose(); }
  });
  it.each(['act', 'plan'] as const)('O4 edits using the actual Claude Read surface and Write-only writer in %s', async mode => {
    const h = await saveHost({ capabilities: ['write'] }); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const bytes = await officeRouteDocument();
    const writer = h.tools('claude-1'); writer.setOfficeEditor(editor); await fs.writeFile(path.join(h.root, 'source.docx'), bytes);
    const backend = new ClaudeHeadlessBackend(config(h.root, { allowedTools: ['read', 'write'] }), undefined, undefined, {
      spawn: fakeSpawn().fn as any, writeRoots: [h.root], delegationContentAssets: h.assets, hostFileTools: writer,
    });
    await backend.start({ MAX_MCP_OUTPUT_TOKENS: '16000' }, { pin: 'take' });
    try {
      backend.sendUserTurn('Edit the document.', { mode }); await vi.waitFor(() => expect((backend as any).filesBridgeTools).toBeDefined());
      (backend as any).filesBridgeTools.setOfficeReader(reader); const spec = await filesBridge(h.root);
      const captured = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'inspect_office', arguments: { path: 'source.docx' } } });
      expect(captured.result.isError, JSON.stringify(captured)).toBeFalsy(); const snapshot = JSON.parse(captured.result.content[0].text).snapshot_ref;
      const result = await rpc(spec, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'edit_office', arguments: {
        schema_version: 1, snapshot_ref: snapshot, path: 'copy.docx', edits: [{ op: 'replace_text', target_ref: 'D1', find: 'Actual Office 名称', replace: 'Changed Office' }],
      } } });
      if (mode === 'plan') { expect(result.result.isError).toBe(true); expect(result.result.content[0].text).toContain('Plan'); await expect(fs.stat(path.join(h.root, 'copy.docx'))).rejects.toMatchObject({ code: 'ENOENT' }); }
      else { expect(result.result.isError, JSON.stringify(result)).toBeFalsy(); const zip = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'copy.docx'))); expect(await zip.file('word/document.xml')!.async('string')).toContain('Changed Office'); }
      expect(writer.specs().some(tool => tool.function.name === 'read_file')).toBe(false); expect(await fs.readFile(path.join(h.root, 'source.docx'))).toEqual(bytes);
    } finally { await backend.stop(50); await reader.dispose(); await h.assets.dispose(); }
  });
  it.each(['act', 'plan'] as const)('v0.9.108 edit_pdf reaches the actual Claude files bridge with a Write-only writer in %s', async mode => {
    const h = await saveHost({ capabilities: ['write'] }); const editor = await pdfRouteEditor(); const pdf = await makePdf([{ text: 'Bridge page' }]);
    const writer = h.tools('claude-1'); writer.setPdfEditor(editor); await fs.writeFile(path.join(h.root, 'in.pdf'), pdf);
    const item = attachment('annex.pdf', 'application/pdf', 'pdf', Buffer.from(await makePdf([{ text: 'Attached annex' }])));
    const sources = await admitUserTurn(h.assets, [item]); h.assets.holdForUserRequest('claude-1', sources.map(source => source.assetId));
    const backend = new ClaudeHeadlessBackend(config(h.root, { allowedTools: ['read', 'write'] }), undefined, undefined, {
      spawn: fakeSpawn().fn as any, writeRoots: [h.root], delegationContentAssets: h.assets, hostFileTools: writer,
    });
    await backend.start({}, { pin: 'take' });
    try {
      backend.sendUserTurn('Merge the PDFs.', { mode, userAttachments: [item], delegationContentSources: sources }); await vi.waitFor(() => expect((backend as any).filesBridgeTools).toBeDefined());
      const spec = await filesBridge(h.root);
      const listed = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      expect(listed.result.tools.some((tool: any) => tool.name === 'edit_pdf')).toBe(true);
      const result = await rpc(spec, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'edit_pdf', arguments: {
        schema_version: 1, destination: 'packet.pdf', inputs: [{ path: 'in.pdf' }, { source_ref: item.contentAssetId }], operations: [{ op: 'merge' }],
      } } });
      if (mode === 'plan') { expect(result.result.isError).toBe(true); expect(result.result.content[0].text).toContain('Plan'); await expect(fs.stat(path.join(h.root, 'packet.pdf'))).rejects.toMatchObject({ code: 'ENOENT' }); }
      else {
        expect(result.result.isError, JSON.stringify(result)).toBeFalsy(); const pages = await pdfTextPort.pages(await fs.readFile(path.join(h.root, 'packet.pdf')));
        expect(pages.map(items => items.map(entry => entry.str).join(''))).toEqual(['Bridge page', 'Attached annex']);
      }
      expect(writer.specs().some(tool => tool.function.name === 'read_file')).toBe(false); expect(await fs.readFile(path.join(h.root, 'in.pdf'))).toEqual(Buffer.from(pdf));
    } finally { await backend.stop(50); await h.assets.dispose(); }
  });
  it.each(['act', 'plan'] as const)('v0.9.108 view_pdf_pages is offered on the authenticated Claude bridge with Commands and refused in %s Plan only', async mode => {
    const h = await saveHost(); const tools = new WorkspaceTools(h.root, new Set(['read', 'write', 'execute']), 'claude-1', undefined, new CommandPolicy('all'));
    tools.setPdfPageRasterPlatform(() => undefined); await fs.writeFile(path.join(h.root, 'in.pdf'), await makePdf([{ text: 'Page' }]));
    const backend = new ClaudeHeadlessBackend(config(h.root, { allowedTools: ['read', 'write', 'execute'] }), undefined, undefined,
      { spawn: fakeSpawn().fn as any, writeRoots: [h.root], delegationContentAssets: h.assets, hostFileTools: tools });
    await backend.start({}, { pin: 'take' });
    try {
      backend.sendUserTurn('Show page one.', { mode }); await vi.waitFor(() => expect((backend as any).filesBridgeTools).toBeDefined()); const spec = await filesBridge(h.root);
      const listed = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }); expect(listed.result.tools.some((tool: any) => tool.name === 'view_pdf_pages')).toBe(true);
      const result = await rpc(spec, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'view_pdf_pages', arguments: { path: 'in.pdf', pages: '1' } } });
      if (mode === 'plan') { expect(result.result.isError).toBe(true); expect(result.result.content[0].text).toContain('Plan'); }
      else { expect(result.result.isError, JSON.stringify(result)).toBeFalsy(); expect(result.result.content[0].text).toContain('platform-unsupported'); }
    } finally { await backend.stop(50); await h.assets.dispose(); }
  });
  it.each(['act', 'plan'] as const)('O4 inspects Office through the authenticated Claude bridge in %s with Commands Off', async mode => {
    const h = await saveHost(); const reader = await officeRouteReader(); const input = await officeRouteDocument();
    await fs.writeFile(path.join(h.root, 'source.docx'), input);
    const backend = new ClaudeHeadlessBackend(config(h.root, { allowedTools: ['read'] }), undefined, undefined, {
      spawn: fakeSpawn().fn as any, writeRoots: [h.root], delegationContentAssets: h.assets,
    });
    await backend.start({ MAX_MCP_OUTPUT_TOKENS: '16000' }, { pin: 'take' });
    try {
      backend.sendUserTurn('Inspect the document.', { mode }); await vi.waitFor(() => expect((backend as any).filesBridgeTools).toBeDefined());
      (backend as any).filesBridgeTools.setOfficeReader(reader); const spec = await filesBridge(h.root);
      const listed = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/list' }); expect(listed.result.tools.some((tool: any) => tool.name === 'inspect_office')).toBe(true);
      // v0.9.108 W1: the Word view parameter reaches the Claude bridge and is honoured there.
      expect(listed.result.tools.find((tool: any) => tool.name === 'inspect_office').inputSchema.properties.view.enum).toEqual(['current', 'original', 'markup']);
      const markup = await rpc(spec, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'inspect_office', arguments: { path: 'source.docx', view: 'markup' } } });
      expect(JSON.parse(markup.result.content[0].text).view).toBe('markup');
      const result = await rpc(spec, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'inspect_office', arguments: { path: 'source.docx' } } });
      expect(result.result.isError, JSON.stringify(result)).toBeFalsy(); const page = JSON.parse(result.result.content[0].text);
      expect(page.next_cursor).toBeNull(); expect(officeRouteParagraph(page)).toMatchObject({ text: 'Actual Office 名称', selector: { snapshot_ref: page.snapshot_ref } });
      expect(await fs.readFile(path.join(h.root, 'source.docx'))).toEqual(input);
    } finally { await backend.stop(50); await reader.dispose(); await h.assets.dispose(); }
  });
  it('O2 counts observed cells only after actual MCP and CLI tool results contain every fragment', async () => {
    const h = await saveHost(); const reader = await workbookRouteReader(); const text = '😀\n"'.repeat(900);
    await fs.writeFile(path.join(h.root, 'delivery.csv'), '"' + text.replaceAll('"', '""') + '",0');
    const fake = fakeSpawn(); const receipts: any[] = [];
    const backend = new ClaudeHeadlessBackend(config(h.root, { allowedTools: ['read'] }), undefined, undefined,
      { spawn: fake.fn as any, writeRoots: [h.root], delegationContentAssets: h.assets, onContentReceipt: receipt => receipts.push(receipt) });
    await backend.start({ MAX_MCP_OUTPUT_TOKENS: '3000' }, { pin: 'take' });
    try {
      backend.sendUserTurn('Read the complete CSV.'); await vi.waitFor(() => expect((backend as any).filesBridgeTools).toBeDefined());
      const tools = (backend as any).filesBridgeTools; tools.setWorkbookReader(reader); const spec = await filesBridge(h.root);
      const name = `mcp__${(backend as any).bridgeIds.files}__read_workbook`;
      const event = async (value: unknown) => { fake.process.stdout.emit('data', JSON.stringify(value) + '\n'); await (backend as any).eventChain; };
      let count = 0;
      const call = async (cursor?: string, partial = false) => {
        const id = `delivery-${++count}`; const args = { path: 'delivery.csv', operation: 'range', ...(cursor ? { cursor } : {}) };
        await event({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: args }] } });
        const response = await rpc(spec, { jsonrpc: '2.0', id: count, method: 'tools/call', params: { name: 'read_workbook', arguments: args, _meta: { 'claudecode/toolUseId': id } } });
        expect(response.result.isError, JSON.stringify(response)).toBeFalsy(); const output = response.result.content[0].text; const page = JSON.parse(output);
        const fact = tools.workbookDeliveryFacts().find((fact: any) => fact.id === page.delivery_ref); expect(fact).toBeDefined(); expect(fact.state).toBe('prepared');
        await event({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: partial ? output.slice(0, -20) : output }] }] } });
        return page;
      };
      let page = await call(); expect(page.next_cursor).toBeTruthy(); const gapCursor = page.next_cursor;
      expect(tools.workbookDeliveryFacts()[0]).toMatchObject({ state: 'observed', observed_units: [], submitted_units: [] });
      page = await call(gapCursor, true); expect(page.next_cursor).toBeTruthy();
      expect(tools.workbookDeliveryFacts()[1]).toMatchObject({ state: 'unknown', observed_units: [], submitted_units: [] });
      while (page.next_cursor) { expect(count).toBeLessThan(20); page = await call(page.next_cursor); }
      expect(tools.workbookDeliveryFacts().flatMap((fact: any) => fact.observed_units)).toEqual(['cell:B1']);
      await call(gapCursor);
      expect(new Set(tools.workbookDeliveryFacts().flatMap((fact: any) => fact.observed_units))).toEqual(new Set(['cell:A1', 'cell:B1']));
      const oldVersion = tools.workbookDeliveryFacts()[0].scope.sourceVersion;
      await fs.writeFile(path.join(h.root, 'delivery.csv'), '"' + text.replaceAll('😀', '😁').replaceAll('"', '""') + '",0');
      page = await call(undefined, true); const freshVersion = tools.workbookDeliveryFacts().find((fact: any) => fact.id === page.delivery_ref).scope.sourceVersion;
      expect(freshVersion).not.toBe(oldVersion);
      while (page.next_cursor) { expect(count).toBeLessThan(40); page = await call(page.next_cursor); }
      expect(tools.workbookDeliveryFacts().filter((fact: any) => fact.scope.sourceVersion === freshVersion).flatMap((fact: any) => fact.observed_units)).toEqual(['cell:B1']);
      expect(receipts.some(receipt => receipt.contentClass === 'workbook' && receipt.action === 'observed' && receipt.observedUnits > 0)).toBe(true);
      expect(JSON.stringify(receipts)).not.toContain('delivery.csv'); expect(JSON.stringify(receipts)).not.toContain(text);
    } finally { await backend.stop(50); await reader.dispose(); await h.assets.dispose(); }
  });
  it('shares workbook custody with the persistent writer while the authenticated read bridge keeps its own permissions', async () => {
    const h = await saveHost(); const reader = await workbookRouteReader(); const tools = h.tools('claude-1'); tools.setWorkbookReader(reader, true);
    const bytes = await typedXlsxFixture(); await fs.writeFile(path.join(h.root, 'shared.xlsx'), bytes);
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, { spawn: fakeSpawn().fn as any, writeRoots: [h.root], hostFileTools: tools });
    await backend.start({}, { pin: 'take' });
    try {
      backend.sendUserTurn('Read the workbook.'); const spec = await filesBridge(h.root);
      const response = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_workbook', arguments: { path: 'shared.xlsx', operation: 'range', range: 'H1' } } });
      expect(response.result.isError, JSON.stringify(response)).toBeFalsy(); const snapshot = JSON.parse(response.result.content[0].text).snapshot_ref;
      (backend as any).filesBridgeTools.retire();
      const writer = await tools.run('read_workbook', { path: 'shared.xlsx', operation: 'range', range: 'K1' });
      expect(writer.status, writer.output).toBe('success'); expect(JSON.parse(writer.output).snapshot_ref).toBe(snapshot);
      expect(await fs.readFile(path.join(h.root, 'shared.xlsx'))).toEqual(bytes);
    } finally { await backend.stop(50); await reader.dispose(); await h.assets.dispose(); }
  });
  it.each(['read-only', 'legacy-unrestricted', 'disabled'] as const)('O2 serves CSV through the authenticated MCP bridge for %s capability', async capability => {
    const h = await saveHost(); const reader = await workbookRouteReader(); const text = '😀\n"'.repeat(600); const original = '"' + text.replaceAll('"', '""') + '",0';
    await fs.writeFile(path.join(h.root, 'table.csv'), original);
    const backend = new ClaudeHeadlessBackend(config(h.root, { allowedTools: capability === 'legacy-unrestricted' ? undefined : capability === 'disabled' ? [] : ['read'] }), undefined, undefined, {
      spawn: fakeSpawn().fn as any, writeRoots: [h.root], delegationContentAssets: h.assets,
      ...(capability === 'legacy-unrestricted' ? { hostFileTools: h.tools('claude-1') } : {}),
    });
    await backend.start({ MAX_MCP_OUTPUT_TOKENS: '3000' }, { pin: 'take' });
    try {
      backend.sendUserTurn('Read the CSV.');
      await vi.waitFor(() => expect((backend as any).filesBridgeTools).toBeDefined());
      const spec = await filesBridge(h.root);
      (backend as any).filesBridgeTools.setWorkbookReader(reader);
      const listed = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      if (capability === 'disabled') {
        expect(listed.result.tools.some((tool: any) => tool.name === 'read_workbook')).toBe(false);
        const blocked = await rpc(spec, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_workbook', arguments: { path: 'table.csv' } } });
        expect(blocked.result?.isError || blocked.error).toBeTruthy(); return;
      }
      expect(listed.result.tools.some((tool: any) => tool.name === 'read_workbook')).toBe(true);
      let cursor: string | undefined; const pages: WorkbookPage[] = [];
      do {
        const result = await rpc(spec, { jsonrpc: '2.0', id: pages.length + 2, method: 'tools/call', params: { name: 'read_workbook',
          arguments: { path: 'table.csv', operation: 'range', ...(cursor ? { cursor } : {}) } } });
        expect(result.result.isError, JSON.stringify(result)).toBeFalsy(); expect(Buffer.byteLength(JSON.stringify(result.result), 'utf8')).toBeLessThanOrEqual(3000);
        const page = JSON.parse(result.result.content[0].text) as WorkbookPage; expect(page.delivery).toBe('prepared'); pages.push(page); cursor = page.next_cursor ?? undefined;
        if (pages.length > 30) throw new Error('CSV bridge did not progress');
      } while (cursor);
      expect(pages.length).toBeGreaterThan(1); const cells = pages.flatMap(page => page.prepared_fragments);
      expect(cells.filter(cell => cell.cell === 'A1').map(cell => cell.text).join('')).toBe(text); expect(cells.filter(cell => cell.cell === 'B1').map(cell => cell.text)).toEqual(['0']);
      expect(await fs.readFile(path.join(h.root, 'table.csv'), 'utf8')).toBe(original);
      await fs.writeFile(path.join(h.root, 'table.xlsx'), await typedXlsxFixture());
      const xlsx = await rpc(spec, { jsonrpc: '2.0', id: 900, method: 'tools/call', params: { name: 'read_workbook',
        arguments: { path: 'table.xlsx', operation: 'range', range: 'H1' } } });
      expect(xlsx.result.isError, JSON.stringify(xlsx)).toBeFalsy();
      expect(JSON.parse(xlsx.result.content[0].text).prepared_fragments[0].record.value).toMatchObject({ kind: 'date-serial', raw: '60', epoch: '1900', excelLeapDay: true });
      await fs.writeFile(path.join(h.root, 'computed.csv'), COMPUTE_CSV);
      const captured = await rpc(spec, { jsonrpc: '2.0', id: 901, method: 'tools/call', params: { name: 'read_workbook', arguments: { path: 'computed.csv' } } });
      const computation = new WorkbookRecordCollector(); let computeArgs: Record<string, unknown> = workbookSumPlan(JSON.parse(captured.result.content[0].text).snapshot_ref);
      for (let count = 0; ; count++) {
        expect(count).toBeLessThan(40); const result = await rpc(spec, { jsonrpc: '2.0', id: 902 + count, method: 'tools/call', params: { name: 'transform_workbook', arguments: computeArgs } });
        expect(result.result.isError, JSON.stringify(result)).toBeFalsy(); expect(Buffer.byteLength(JSON.stringify(result.result), 'utf8')).toBeLessThanOrEqual(3000);
        const page = JSON.parse(result.result.content[0].text); computation.add(page); if (!page.next_cursor) break; computeArgs = { operation: 'read', data_ref: page.data_ref, cursor: page.next_cursor };
      }
      const totals = computation.records().filter(item => item.kind === 'row'); expect(totals).toHaveLength(2);
      expect(totals.find(item => item.record.cells.team.text === 'A').record.cells.total.exact).toEqual({ numerator: '3', denominator: '10' });
      expect((backend as any).filesBridgeTools.workbookDeliveryFacts().every((fact: any) => fact.state === 'prepared' && !fact.submitted_units.length && !fact.observed_units.length)).toBe(true);
    } finally { await backend.stop(50); await reader.dispose(); await h.assets.dispose(); }
  });
  it('O3 advertises and writes editable PPTX through the authenticated files bridge; Plan stays read-only', async () => {
    const h = await saveHost({ capabilities: ['write'] }); const tools = h.tools('claude-1'); tools.setPresentationRenderer(await presentationRouteRenderer());
    tools.setDocumentRenderer(await documentRouteRenderer());
    const reader = await workbookRouteReader(); tools.setWorkbookReader(reader);
    const outside = await temporaryFolder('unode-claude-binding-source-'); const sourcePath = path.join(outside, 'table.csv'); await fs.writeFile(sourcePath, COMPUTE_CSV);
    const scope = new SessionLocalReadScopeConsent(async () => false);
    await scope.requestPathAccess(sourcePath, { requestId: 'r1', isCurrent: () => true }, async () => ({ permission: 'read', lifetime: 'session' }));
    const sources = await admitUserTurn(h.assets, [attachment('pixels.png', 'image/png', 'image', PRESENTATION_PNG)]);
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, { spawn: fakeSpawn().fn as any,
      writeRoots: [h.root], hostFileTools: tools, livePathAccess: () => scope.pathAccessFor('r1') });
    await backend.start({}, { pin: 'take' });
    try {
      backend.sendUserTurn('Make the slides.', { delegationContentSources: sources }); const spec = await filesBridge(h.root);
      const listed = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(listed.result.tools.some((tool: any) => tool.name === 'write_presentation')).toBe(true);
      const input = presentationWithImage(attachmentIds(sources)[0]);
      const part = await rpc(spec, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write_presentation',
        arguments: { ...input, draft: 'deck', deck: { ...input.deck, title: 'A'.repeat(75000) } } } });
      expect(part.result.isError).toBeFalsy(); expect(existsSync(path.join(h.root, input.path))).toBe(false);
      const written = await rpc(spec, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'write_presentation',
        arguments: { ...input, draft: 'deck', final: true, deck: { ...input.deck, slides: [] } } } });
      expect(written.result.isError).toBeFalsy();
      const bytes = await fs.readFile(path.join(h.root, 'out/result.pptx')); await assertEditablePresentation(bytes);
      await assertOriginalPngEmbedded(bytes);
      expect(written.result.content[0].text).toContain(sha(bytes));
      expect([...(backend as any).turnEvidence.changedFiles]).toContain('out/result.pptx');
      const capture = await rpc(spec, { jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'read_workbook', arguments: { path: sourcePath } } });
      const computed = await rpc(spec, { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'transform_workbook', arguments: workbookSumPlan(JSON.parse(capture.result.content[0].text).snapshot_ref) } });
      const bound = await rpc(spec, { jsonrpc: '2.0', id: 43, method: 'tools/call', params: { name: 'write_presentation', arguments: boundPresentationInput(JSON.parse(computed.result.content[0].text).transformation_ref) } });
      expect(bound.result.isError, JSON.stringify(bound)).toBeFalsy(); await assertBoundPresentation(await fs.readFile(path.join(h.root, 'out/bound.pptx')));
      const word = await rpc(spec, { jsonrpc: '2.0', id: 45, method: 'tools/call', params: { name: 'write_document', arguments: boundDocumentInput(JSON.parse(computed.result.content[0].text).transformation_ref) } });
      expect(word.result.isError, JSON.stringify(word)).toBeFalsy(); await assertBoundDocument(await fs.readFile(path.join(h.root, 'out/bound.docx')));
      (backend as any).config.allowedTools = ['write'];
      const off = await rpc(spec, { jsonrpc: '2.0', id: 44, method: 'tools/call', params: { name: 'write_presentation', arguments: { ...boundPresentationInput(JSON.parse(computed.result.content[0].text).transformation_ref), path: 'out/off.pptx' } } });
      expect(off.result.isError).toBe(true); expect(off.result.content[0].text).toContain('Read is Off'); expect(existsSync(path.join(h.root, 'out/off.pptx'))).toBe(false);
      const wordOff = await rpc(spec, { jsonrpc: '2.0', id: 46, method: 'tools/call', params: { name: 'write_document', arguments: { ...boundDocumentInput(JSON.parse(computed.result.content[0].text).transformation_ref), path: 'out/off.docx' } } });
      expect(wordOff.result.isError).toBe(true); expect(wordOff.result.content[0].text).toContain('Read is Off'); expect(existsSync(path.join(h.root, 'out/off.docx'))).toBe(false);
      backend.sendUserTurn('Plan only.', { mode: 'plan' });
      const plan = await rpc(spec, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'write_presentation', arguments: presentationInput('out/plan.pptx') } });
      expect(plan.result.isError).toBe(true); expect(existsSync(path.join(h.root, 'out/plan.pptx'))).toBe(false);
    } finally { await backend.stop(50); await reader.dispose(); await h.assets.dispose(); }
  });
  it('sends a PDF fallback through the actual files bridge and emits one runtime reminder', async () => {
    const h = await saveHost(); const tools = h.tools('claude-1');
    tools.setDocumentRenderer(await documentRouteRenderer());
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, { spawn: fakeSpawn().fn as any,
      writeRoots: [h.root], hostFileTools: tools });
    const events: any[] = []; backend.onEvent(event => events.push(event));
    await backend.start({}, { pin: 'take' });
    try {
      backend.sendUserTurn('Make a PDF.'); const spec = await filesBridge(h.root);
      const result = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'write_document', arguments: documentInput('pdf', '\u0627'),
      } });
      expect(result.result.isError).toBe(true);
      expect(result.result.content[0].text).toContain('write the same document now with format docx');
      expect(result.result.content[0].text).toContain('Export as PDF');
      expect(events.filter(event => event.kind === 'runtime_notice')).toEqual([
        { kind: 'runtime_notice', text: expect.stringContaining('asked the agent to save it as Word') },
      ]);
    } finally { await backend.stop(50); }
  });
  it.each(['docx', 'pdf'] as const)('lists and writes %s, with a host fact joined to the CLI tool-use id', async format => {
    const h = await saveHost(); const tools = h.tools('claude-1'); tools.setDocumentRenderer(await documentRouteRenderer());
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, { spawn: fakeSpawn().fn as any,
      writeRoots: [h.root], hostFileTools: tools });
    const events: any[] = []; backend.onEvent(event => events.push(event));
    await backend.start({}, { pin: 'take' });
    try {
      backend.sendUserTurn('Make a contract.'); const spec = await filesBridge(h.root);
      const input = documentInput(format, format === 'docx' ? 'مرحبا' : 'CONTRACT 123');
      const listed = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(listed.result.tools.find((tool: any) => tool.name === 'write_document')).toEqual({
        name: 'write_document', description: WRITE_DOCUMENT_SPEC.function.description, inputSchema: WRITE_DOCUMENT_SPEC.function.parameters });
      const name = `mcp__${(backend as any).bridgeIds.files}__write_document`;
      (backend as any).handleEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'doc-1', name, input }] } });
      await (backend as any).eventChain;
      const result = await rpc(spec, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'write_document', arguments: input, _meta: { 'claudecode/toolUseId': 'doc-1' } } });
      expect(result.result.isError).toBeFalsy(); const output = result.result.content[0].text;
      (backend as any).handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'doc-1', content: output }] } });
      await (backend as any).eventChain;
      const bytes = await fs.readFile(path.join(h.root, `out/result.${format}`));
      expect(bytes.subarray(0, 4).toString('hex')).toBe(format === 'docx' ? '504b0304' : '25504446');
      expect(events.find(event => event.kind === 'tool_result')).toMatchObject({ outcome: { status: 'success', observedBy: 'host' },
        documentWrite: { code: 'written', receipt: { format, sha256: sha(bytes), bytes: bytes.length } } });
      if (format === 'docx') expect(events.find(event => event.kind === 'tool_result')).toMatchObject({ summary: expect.stringContaining('reader layout unverified') });
      backend.sendUserTurn('Plan only.', { mode: 'plan' });
      const plan = await rpc(spec, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'write_document', arguments: documentInput(format) } });
      expect(plan.result.isError).toBe(true); expect(plan.result.content[0].text).toContain('unavailable in Plan mode');
    } finally { await backend.stop(50); }
  });
  // v0.9.99 (B15): a contract the coordinator filed still governs its own writes in the actual handler; with no
  // contract in force the write runs under its own permissions and the result carries the delegation reminder.
  it('checks the coordinator contract in the actual handler, not only the PreToolUse hook', async () => {
    const h = await saveHost(); const tools = h.tools(); tools.setDocumentRenderer(await documentRouteRenderer());
    let attempt: unknown = { contractId: 'contract-1' };
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, { hostFileTools: tools,
      teamMcpBridge: { hasTeammates: () => true, currentCoordinatorTaskAttempt: () => attempt, canCoordinatorExecute: () => false } as any });
    const doc = (backend as any).buildFilesBridgeTools(new (tools.constructor as any)(h.root, new Set(['read']))).find((tool: any) => tool.name === 'write_document');
    const refused = await doc.handler(documentInput('docx'), { signal: new AbortController().signal });
    expect(refused.outcome).toMatchObject({ status: 'refused' });
    expect(JSON.stringify(refused)).toContain('outside the task contract you filed');
    expect(await fs.readdir(h.root)).toEqual([]);
    attempt = undefined;
    const own = await doc.handler(documentInput('docx'), { signal: new AbortController().signal });
    expect(own.outcome).toMatchObject({ status: 'success' });
    expect(JSON.stringify(own)).toContain('[host reminder] You have teammates.');
    expect(existsSync(path.join(h.root, 'out/result.docx'))).toBe(true);
  });
  it('accepts a valid structured document over 64 KiB without widening other bridge tool bodies', async () => {
    const h = await saveHost(); const tools = h.tools(); tools.setDocumentRenderer(await documentRouteRenderer());
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, { spawn: fakeSpawn().fn as any,
      writeRoots: [h.root], hostFileTools: tools });
    await backend.start({}, { pin: 'take' });
    try {
      backend.sendUserTurn('Make a long document.'); const spec = await filesBridge(h.root);
      const input = documentInput('docx'); input.document.blocks = [{ type: 'paragraph', content: Array.from({ length: 10 }, () => ({ text: 'A'.repeat(7500) })) }] as any;
      expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(65536);
      const result = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_document', arguments: input } });
      expect(result.result.isError).toBeFalsy(); expect(existsSync(path.join(h.root, input.path))).toBe(true);
      const other = await rpc(spec, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'x', extra: 'A'.repeat(70000) } } });
      expect(other).toEqual({ error: 'bad request' });
    } finally { await backend.stop(50); }
  });
  it('v0.9.102 field fix 4: a document the host wrote is this turn\'s changed file, and its receipt names the full path written', async () => {
    const h = await saveHost(); const tools = h.tools(); tools.setDocumentRenderer(await documentRouteRenderer());
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, { spawn: fakeSpawn().fn as any,
      writeRoots: [h.root], hostFileTools: tools });
    await backend.start({}, { pin: 'take' });
    try {
      backend.sendUserTurn('Write the summary.'); const spec = await filesBridge(h.root);
      const result = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_document', arguments: documentInput('docx') } });
      expect(result.result.isError).toBeFalsy();
      expect(result.result.content[0].text).toContain(
        `Document written: out/result.docx\nFull path written: ${realpathSync.native(path.join(h.root, 'out/result.docx'))}\n`);
      // As a native Write is: the file reaches the task's evidence, so a required output written here is seen.
      expect([...(backend as any).turnEvidence.changedFiles]).toEqual(['out/result.docx']);
    } finally { await backend.stop(50); }
  });
  // v0.9.99: the local MCP body no longer caps a document at 1 MiB; draft parts are not request effects.
  it('accepts a write_document body over the former 1 MiB document ceiling and holds only the final draft part at a request limit', async () => {
    const h = await saveHost(); const tools = h.tools(); tools.setDocumentRenderer(await documentRouteRenderer());
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, { spawn: fakeSpawn().fn as any,
      writeRoots: [h.root], hostFileTools: tools });
    await backend.start({}, { pin: 'take' });
    try {
      backend.sendUserTurn('Make a very long document.'); const spec = await filesBridge(h.root);
      const input = documentInput('docx');
      input.document.blocks = Array.from({ length: 160 }, (_, i) => ({ type: 'paragraph', content: [{ text: `P${i} ${'A'.repeat(7500)}` }] })) as any;
      expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(1_048_576);
      const result = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_document', arguments: input } });
      expect(result.result.isError).toBeFalsy(); expect(result.result.content[0].text).toContain('Document written');
      expect(existsSync(path.join(h.root, input.path))).toBe(true);
      const files = `mcp__${(backend as any).bridgeIds.files}__write_document`.toLowerCase();
      expect((backend as any).isRequestEffect(files, { ...input, draft: 'long' })).toBe(false);
      expect((backend as any).isRequestEffect(files, { ...input, draft: 'long', final: true })).toBe(true);
      expect((backend as any).isRequestEffect(files, input)).toBe(true);
    } finally { await backend.stop(50); }
  }, 60_000);
});

describe('save_attachment over Claude\'s files bridge (review resolution §2)', () => {
  it('lists the tool with its one description and input, allows it at launch, and saves byte for byte', async () => {
    const { h, sources, backend, spawn, id } = await claudeWithHostTools();
    try {
      const spec = await filesBridge(h.root);
      const list = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const tool = list.result.tools.find((candidate: any) => candidate.name === 'save_attachment');
      expect(tool.description).toBe(SAVE_ATTACHMENT_DESCRIPTION);
      expect(tool.inputSchema).toEqual({ type: 'object', properties: { asset_id: expect.any(Object), path: expect.any(Object) }, required: ['asset_id', 'path'] });
      // The bridge's other tools stay what they were: no write tool of the host is offered beside it.
      expect(list.result.tools.map((candidate: any) => candidate.name)).not.toContain('write_file');
      expect(spawn.calls[0].args).toContainEqual(expect.stringMatching(/^mcp__unode_files_[a-f0-9]{32}__save_attachment$/));

      // Before the turn names its attachments, the tools hold no grant to them.
      expect((await call(spec, { asset_id: id, path: 'early.png' })).result.content[0].text).toMatch(/asset-unavailable/);
      backend.sendUserTurn('save it', { delegationContentSources: sources });
      const saved = await call(spec, { asset_id: id, path: 'assets/logo.png' });
      expect(saved.result.isError).toBeFalsy();
      expect(saved.result.content[0].text).toContain(`Saved attachment ${id} to assets/logo.png as a new file: ${PNG.length} bytes, SHA-256 ${sha(PNG)}`);
      expect((await fs.readFile(path.join(h.root, 'assets', 'logo.png'))).equals(PNG)).toBe(true);
      expect(existsSync(path.join(h.root, 'early.png'))).toBe(false);
    } finally {
      await backend.stop(50);
    }
  });

  it('refuses in Plan mode, and the next turn holds only its own grants', async () => {
    const { h, sources, backend, id } = await claudeWithHostTools();
    try {
      const spec = await filesBridge(h.root);
      backend.sendUserTurn('plan it', { mode: 'plan', delegationContentSources: sources });
      expect((await call(spec, { asset_id: id, path: 'plan.png' })).result.content[0].text).toMatch(/unavailable in Plan mode/);
      backend.sendUserTurn('another request', {});
      expect((await call(spec, { asset_id: id, path: 'later.png' })).result.content[0].text).toMatch(/asset-unavailable/);
      expect(existsSync(path.join(h.root, 'plan.png')) || existsSync(path.join(h.root, 'later.png'))).toBe(false);
    } finally {
      await backend.stop(50);
    }
  });

  it('stopping the agent retires the host tools, so a save still on its way makes no effect', async () => {
    const { h, sources, tools, backend, id } = await claudeWithHostTools();
    backend.sendUserTurn('save it', { delegationContentSources: sources });
    await backend.stop(50);
    const result = await tools.run('save_attachment', { asset_id: id, path: 'logo.png' });
    expect(result).toMatchObject({ status: 'failed', attachmentSave: { code: 'interrupted' } });
    expect(existsSync(path.join(h.root, 'logo.png'))).toBe(false);
  });

  it('is not listed without the host tools', async () => {
    const { h, backend } = await claudeWithHostTools(false);
    try {
      const list = await rpc(await filesBridge(h.root), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(list.result.tools.map((candidate: any) => candidate.name)).not.toContain('save_attachment');
    } finally {
      await backend.stop(50);
    }
  });

  // v0.9.99 (B15): as Write does, a coordinator with teammates saves under its own permissions when no contract is in
  // force, and is refused only by a contract it filed that does not cover the save.
  it('follows the coordinator contract rule, as Write does, when the agent coordinates teammates', async () => {
    const h = await saveHost();
    let attempt: unknown = undefined;
    const team = {
      hasTeammates: () => true,
      currentCoordinatorTaskAttempt: () => attempt,
      canCoordinatorExecute: () => false,
    };
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, {
      writeRoots: [h.root],
      hostFileTools: h.tools('claude-1'),
      teamMcpBridge: team as any,
    });
    const files = (backend as any).bridgeIds.files as string;
    const own = await (backend as any).decidePreToolUse(`mcp__${files}__save_attachment`, { asset_id: 'content-1', path: 'a.png' });
    expect(own.refusal).not.toBe('capability');
    attempt = { contractId: 'contract-1' };
    const decision = await (backend as any).decidePreToolUse(`mcp__${files}__save_attachment`, { asset_id: 'content-1', path: 'a.png' });
    expect(decision).toMatchObject({ allow: false, refusal: 'capability' });
    expect(decision.note).toMatch(/outside the task contract you filed/);
  });
});

// v0.9.99 (A11, the same failure on the Claude CLI): a PDF no longer fails the whole turn. Its bytes never go into the
// CLI's input; the model reads it through its files bridge's extracted-content reader, with the id the turn grants.
describe('a Claude turn with a PDF attachment continues (v0.9.99)', () => {
  function writingSpawn(writes: string[]) {
    const base = fakeSpawn();
    return (cmd: string, args: string[]) => {
      const proc = base.fn(cmd, args);
      proc.stdin = { write: (text: string) => { writes.push(text); return true; }, end: () => undefined };
      return proc;
    };
  }
  const userText = (writes: string[]): string => {
    const content = JSON.parse(writes.find((w) => w.includes('"type":"user"'))!).message.content;
    return typeof content === 'string' ? content : content.map((part: any) => part.text ?? '').join(' ');
  };

  it('sends the turn, points the model at read_extracted_content, and the bridge reads the granted PDF', async () => {
    const h = await saveHost();
    const pdf = attachment('board-pack.pdf', 'application/pdf', 'pdf', PDF);
    const sources = await admitUserTurn(h.assets, [pdf]);
    const writes: string[] = [];
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, {
      spawn: writingSpawn(writes) as any, writeRoots: [h.root], delegationContentAssets: h.assets,
    });
    const events: any[] = []; backend.onEvent((event) => events.push(event));
    await backend.start({} as NodeJS.ProcessEnv, { pin: 'take' });
    try {
      backend.sendUserTurn('Summarise it.', { userAttachments: [pdf], delegationContentSources: sources } as any);
      const text = userText(writes);
      expect(text).toContain('[attached PDFs]');
      expect(text).toContain('read_extracted_content');
      expect(text).toContain('- board-pack.pdf');
      expect(writes.join('')).not.toContain(pdf.dataBase64);
      expect(events.some((event) => event.kind === 'turn_complete')).toBe(false);
      expect(events.some((event) => event.kind === 'runtime_notice')).toBe(false);
      // Never reported as sent: the reader reaches it, the CLI's input does not carry it.
      expect(events.filter((event) => event.kind === 'turn_input_delivered').map((event) => event.userAttachments)).toEqual([[]]);
      const spec = await filesBridge(h.root);
      const read = await rpc(spec, { jsonrpc: '2.0', id: 9, method: 'tools/call',
        params: { name: 'read_extracted_content', arguments: { assetId: attachmentIds(sources)[0] } } });
      // The grant reaches the asset: the fixture PDF has no pages, so the reader reports its content, not its access.
      expect(read.result.content[0].text).toContain('extracted content is malformed');
      expect(read.result.content[0].text).not.toContain('not available to this agent');
    } finally { await backend.stop(50); }
  });

  it('without a reader, sends the turn, says the PDF was not delivered, and tells the user', async () => {
    const h = await saveHost();
    const pdf = attachment('board-pack.pdf', 'application/pdf', 'pdf', PDF);
    const writes: string[] = [];
    const backend = new ClaudeHeadlessBackend(config(h.root), undefined, undefined, { spawn: writingSpawn(writes) as any });
    const events: any[] = []; backend.onEvent((event) => events.push(event));
    await backend.start({} as NodeJS.ProcessEnv, { pin: 'take' });
    try {
      backend.sendUserTurn('Summarise it.', { userAttachments: [pdf] } as any);
      const text = userText(writes);
      expect(text).toContain('[attachments not delivered]');
      expect(text).toContain('Do not say you read or reviewed them.');
      expect(text).not.toContain('read_extracted_content');
      expect(events.filter((event) => event.kind === 'runtime_notice')).toEqual([{ kind: 'runtime_notice',
        text: expect.stringMatching(/^The agent did not receive board-pack\.pdf: .*The turn continues without it\./) }]);
      expect(events.some((event) => event.kind === 'turn_complete')).toBe(false);
    } finally { await backend.stop(50); }
  });
});

describe('v0.9.108 workbook writers through the actual Claude files bridge', () => {
  it.each(['act', 'plan'] as const)('lists edit_workbook/write_workbook and edits with the Claude Read surface in %s', async mode => {
    const h = await saveHost({ capabilities: ['write'] }); const reader = await workbookRouteReader(); const editor = await workbookRouteEditor(); const bytes = await workbookFixture();
    const writer = h.tools('claude-1'); writer.setWorkbookEditor(editor); await fs.writeFile(path.join(h.root, 'book.xlsx'), bytes);
    const backend = new ClaudeHeadlessBackend(config(h.root, { allowedTools: ['read', 'write'] }), undefined, undefined, {
      spawn: fakeSpawn().fn as any, writeRoots: [h.root], delegationContentAssets: h.assets, hostFileTools: writer,
    });
    await backend.start({ MAX_MCP_OUTPUT_TOKENS: '16000' }, { pin: 'take' });
    try {
      backend.sendUserTurn('Edit the workbook.', { mode }); await vi.waitFor(() => expect((backend as any).filesBridgeTools).toBeDefined());
      (backend as any).filesBridgeTools.setWorkbookReader(reader); const spec = await filesBridge(h.root);
      expect((backend as any).filesBridgeToolNames()).toEqual(expect.arrayContaining(['edit_workbook', 'write_workbook']));
      const listed = await rpc(spec, { jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} });
      expect(listed.result.tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining(['edit_workbook', 'write_workbook']));
      const captured = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_workbook', arguments: { path: 'book.xlsx' } } });
      expect(captured.result.isError, JSON.stringify(captured)).toBeFalsy(); const snapshot = JSON.parse(captured.result.content[0].text).snapshot_ref;
      const result = await rpc(spec, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'edit_workbook', arguments: {
        schema_version: 1, snapshot_ref: snapshot, path: 'copy.xlsx', edits: [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'B1', values: [[42]] }] } } });
      if (mode === 'plan') { expect(result.result.isError).toBe(true); expect(result.result.content[0].text).toContain('Plan'); await expect(fs.stat(path.join(h.root, 'copy.xlsx'))).rejects.toMatchObject({ code: 'ENOENT' }); }
      else {
        expect(result.result.isError, JSON.stringify(result)).toBeFalsy();
        const zip = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'copy.xlsx'))); expect(await zip.file('xl/worksheets/sheet1.xml')!.async('string')).toContain('<c r="B1"><v>42</v></c>');
      }
      expect(await fs.readFile(path.join(h.root, 'book.xlsx'))).toEqual(bytes);
    } finally { await backend.stop(50); await reader.dispose(); await h.assets.dispose(); }
  });
});

describe('v0.9.108 recalculate_workbook on the actual Claude files bridge', () => {
  it('lists it for a writer with Commands and a Claude Read surface, and refuses it in Plan', async () => {
    const h = await saveHost({ capabilities: ['write', 'execute'] }); const writer = h.tools('claude-1');
    const backend = new ClaudeHeadlessBackend(config(h.root, { allowedTools: ['read', 'write', 'execute'] }), undefined, undefined, {
      spawn: fakeSpawn().fn as any, writeRoots: [h.root], delegationContentAssets: h.assets, hostFileTools: writer });
    await backend.start({ MAX_MCP_OUTPUT_TOKENS: '16000' }, { pin: 'take' });
    try {
      backend.sendUserTurn('Recalculate.', { mode: 'plan' }); await vi.waitFor(() => expect((backend as any).filesBridgeTools).toBeDefined());
      expect((backend as any).filesBridgeToolNames()).toContain('recalculate_workbook'); const spec = await filesBridge(h.root);
      const listed = await rpc(spec, { jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }); expect(listed.result.tools.map((tool: any) => tool.name)).toContain('recalculate_workbook');
      const result = await rpc(spec, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recalculate_workbook', arguments: { schema_version: 1, path: 'book.xlsx', targets: { cells: [{ sheet_id: 'sheet-1', refs: ['A1'] }] } } } });
      expect(result.result.isError).toBe(true); expect(result.result.content[0].text).toContain('Plan');
    } finally { await backend.stop(50); await h.assets.dispose(); }
  });
});
