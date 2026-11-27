/*
 * v0.9.97 P4: Codex reaches `save_attachment` as a dynamic tool served by the host's own file tools (review
 * resolution §2 route matrix: "save_attachment ... Codex CLI: exposed through the existing MCP file service as the
 * same host tool"). The App Server is a fake that answers the start-up checks and records what the backend sends.
 */
import { EventEmitter } from 'events';
import { existsSync, realpathSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_CLI_DEFAULT_MODEL, CodexBackend } from '../CodexBackend';
import { SAVE_ATTACHMENT_DESCRIPTION, WorkspaceTools } from '../WorkspaceTools';
import { CommandPolicy } from '../CommandPolicy';
import type { AgentConfig, UserAttachment } from '../../types';
import { admitUserTurn, attachment, attachmentIds, PDF, PNG, saveHost, sha } from './attachmentSaveFixtures';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';
import { SessionLocalReadScopeConsent } from '../localReadScope';
import { fixedCodexProgram } from './codexProgramFixture';
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
import { readDelegatedSourceInline } from '../../content/DelegatedSourceRead';
import { pdfRouteEditor } from './pdfRouteFixtures';
import { makePdf, textPort as pdfTextPort } from '../../office/pdf/__tests__/pdfFixtures';

afterEach(removeTemporaryFolders);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function config(dir: string): AgentConfig {
  return {
    id: 'codex-1', name: 'Codex Dev', role: 'developer', skill: '',
    provider: { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' }, model: CODEX_CLI_DEFAULT_MODEL,
    systemPrompt: 'Work.', autoApprove: true, allowedTools: ['read', 'write', 'execute'], backend: 'codex', workingDirectory: dir,
  };
}

/** Just enough App Server: the start-up checks answered from the host's own argv, one thread, one turn. */
function fakeAppServer() {
  const setting = (args: readonly string[], key: string): unknown => {
    const raw = args.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1);
    if (raw === undefined) return undefined;
    try { return JSON.parse(raw); } catch { return raw; }
  };
  const clientMessages: any[] = [];
  const responses: any[] = [];
  let proc: any;
  const emit = (message: unknown) => queueMicrotask(() => proc.stdout.emit('data', `${JSON.stringify(message)}\n`));
  const spawn = (_command: string, args: string[]) => {
    proc = new EventEmitter();
    proc.pid = 4321;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined;
    proc.stderr.setEncoding = () => undefined;
    proc.stdin = {
      writable: true,
      write(text: string) {
        for (const line of text.trim().split(/\r?\n/)) {
          if (!line) continue;
          const message = JSON.parse(line);
          clientMessages.push(message);
          const reply = (result: unknown) => emit({ jsonrpc: '2.0', id: message.id, result });
          if (message.method === 'initialize') reply({ userAgent: 'fake' });
          else if (message.method === 'config/read') reply({
            config: {
              model_provider: 'openai', analytics: { enabled: false }, otel: { exporter: 'none' },
              approval_policy: setting(args, 'approval_policy'), approvals_reviewer: setting(args, 'approvals_reviewer'),
              sandbox_mode: setting(args, 'sandbox_mode'),
              sandbox_workspace_write: { network_access: setting(args, 'sandbox_workspace_write.network_access') === true },
              apps: { _default: {
                default_tools_approval_mode: setting(args, 'apps._default.default_tools_approval_mode'),
                approvals_reviewer: setting(args, 'apps._default.approvals_reviewer'),
              } },
            },
            origins: {}, layers: [],
          });
          else if (message.method === 'model/list') reply({ data: [] });
          else if (message.method === 'skills/extraRoots/set' || message.method === 'turn/interrupt') reply({});
          else if (message.method === 'skills/list') reply({ data: [] });
          else if (message.method === 'thread/start' || message.method === 'thread/resume') reply({
            thread: { id: 'thread-1' }, cwd: message.params.cwd, approvalPolicy: message.params.approvalPolicy,
            approvalsReviewer: message.params.approvalsReviewer, modelProvider: message.params.modelProvider,
            runtimeWorkspaceRoots: message.params.runtimeWorkspaceRoots,
            // The sandbox asked for, as App Server reports it back: Plan mode asks for read-only.
            sandbox: message.params.sandbox === 'read-only'
              ? { type: 'readOnly', networkAccess: false }
              : { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
          });
          else if (message.method === 'turn/start') reply({ turn: { id: 'turn-1', status: 'inProgress' } });
          else if (message.id !== undefined && !message.method) responses.push(message);
        }
        return true;
      },
      end() { proc.stdin.writable = false; },
    };
    proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); return true; };
    return proc;
  };
  return {
    spawn: spawn as any,
    clientMessages,
    responses,
    completeTurn() { emit({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } }); },
    toolCall(tool: string, args: Record<string, unknown>, id: string) {
      emit({ jsonrpc: '2.0', id, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: id, namespace: null, tool, arguments: args } });
    },
  };
}

async function codexWith(options: {
  hostFileTools?: (tools: WorkspaceTools) => WorkspaceTools | undefined; teamMcpBridge?: any;
  requestBoundary?: any; attached?: UserAttachment[]; hostReadFile?: boolean; writeOnlyWriter?: boolean;
  readAccess?: NonNullable<ConstructorParameters<typeof CodexBackend>[2]>['hostReadAccess'];
  onContentReceipt?: NonNullable<ConstructorParameters<typeof CodexBackend>[2]>['onContentReceipt'];
  capabilities?: readonly string[];
  withSourceReader?: boolean;
  writerCapabilities?: readonly string[];
} = {}) {
  const h = await saveHost({ ...(options.writerCapabilities ? { capabilities: options.writerCapabilities } : options.writeOnlyWriter ? { capabilities: ['write'] } : {}) });
  const sources = await admitUserTurn(h.assets, options.attached ?? [attachment('image.png', 'image/png', 'image', PNG)]);
  const tools = h.tools('codex-1');
  const fake = fakeAppServer();
  const inlineDelivered = vi.fn();
  const hostFileTools = options.hostFileTools ? options.hostFileTools(tools) : tools;
  const backend = new CodexBackend({ ...config(h.root), ...(options.capabilities ? { allowedTools: [...options.capabilities] } : {}) }, undefined, {
    launchProgram: fixedCodexProgram('C:/tools/codex.exe'),
    spawn: fake.spawn,
    access: () => ({ trusted: true, restricted: false, readRoots: [h.root], writeRoots: [h.root] }),
    requestApproval: async () => ({ allow: false }),
    killProcessTree: async () => undefined,
    ...(hostFileTools ? { hostFileTools } : {}),
    ...(options.teamMcpBridge ? { teamMcpBridge: options.teamMcpBridge } : {}),
    ...(options.requestBoundary ? { requestBoundary: options.requestBoundary } : {}),
    ...(options.hostReadFile ? { hostReadFile: true } : {}),
    delegationContentAssets: h.assets,
    ...(options.withSourceReader ? { delegatedSources: { read: (source, attempt) => readDelegatedSourceInline(h.assets, undefined, 'codex-1', source, attempt), delivered: inlineDelivered } } : {}),
    ...(options.readAccess ? { hostReadAccess: options.readAccess } : {}),
    ...(options.onContentReceipt ? { onContentReceipt: options.onContentReceipt } : {}),
  });
  await backend.start({ PATH: 'safe' }, { pin: 'take' });
  return { h, sources, tools, fake, backend, inlineDelivered, id: attachmentIds(sources)[0] };
}

async function turn(backend: CodexBackend, attachments: Record<string, unknown>): Promise<void> {
  backend.sendUserTurn('save it', attachments as any);
  await tick();
  await tick();
}

async function answer(fake: ReturnType<typeof fakeAppServer>, id: string): Promise<any> {
  return vi.waitFor(() => {
    const response = fake.responses.find(response => response.id === id);
    expect(response).toBeDefined(); return response;
  }, { timeout: 10_000 });
}

import { typedXlsxFixture } from '../../content/__tests__/xlsxFixtures';
describe('D3 Codex App Server dynamic document tools', () => {
  it.each(['read-off', 'write-off'] as const)('O4 keeps edit_office unavailable for explicit %s', async off => {
    const { h, fake, backend } = await codexWith({ hostReadFile: true, writeOnlyWriter: true, capabilities: off === 'read-off' ? ['write'] : ['read'] });
    try {
      await turn(backend, { mode: 'act' }); const offered = fake.clientMessages.find(message => message.method === 'thread/start').params.dynamicTools;
      expect(offered.some((tool: any) => tool.name === 'edit_office')).toBe(false);
      fake.toolCall('edit_office', { schema_version: 1, snapshot_ref: 'unavailable', path: 'copy.docx', edits: [] }, 'disabled-edit');
      const result = (await answer(fake, 'disabled-edit')).result; expect(result.success).toBe(false); expect(result.contentItems[0].text).toContain('Read and Write capabilities');
      expect(result.contentItems[0].text).not.toContain('New Model Conversation'); await expect(fs.stat(path.join(h.root, 'copy.docx'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await backend.stop(50); await h.assets.dispose(); }
  });
  it('O4 preserves a saved reading/writing thread without new Office tools instead of resetting it', async () => {
    const { h, fake, backend } = await codexWith({ hostReadFile: true, writeOnlyWriter: true });
    const resets = vi.fn(); (backend as any).deps.onConversationReset = resets;
    const saved = JSON.parse((backend as any).dynamicToolSignature()); expect(saved.editOffice).toBe(true);
    delete saved.readWorkbook; delete saved.inspectOffice; delete saved.editOffice; delete saved.documentSources; const signature = JSON.stringify(saved);
    backend.restore({ version: 3, backend: 'codex', hostTurnState: 'complete', messages: [{ codexThreadId: 'old-writer-thread', codexDynamicTools: signature }] });
    try {
      await turn(backend, { mode: 'act' }); expect(fake.clientMessages.some(message => message.method === 'thread/resume')).toBe(true);
      expect(fake.clientMessages.some(message => message.method === 'thread/start')).toBe(false); expect(resets).not.toHaveBeenCalled();
      expect(backend.snapshot()?.messages[0]).toMatchObject({ codexDynamicTools: signature });
      fake.toolCall('edit_office', { schema_version: 1, snapshot_ref: 'unavailable', path: 'copy.docx', edits: [] }, 'old-edit');
      const refused = (await answer(fake, 'old-edit')).result; expect(refused.success).toBe(false);
      expect(refused.contentItems[0].text).toContain('edit_office'); expect(refused.contentItems[0].text).toContain('New Model Conversation (keep chat)');
      expect(resets).not.toHaveBeenCalled(); await expect(fs.stat(path.join(h.root, 'copy.docx'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await backend.stop(50); await h.assets.dispose(); }
  });
  it('reads and edits original attachment source_ref bytes through actual Codex dynamic tools', async () => {
    const bytes = await officeRouteDocument(); const item = attachment('source.docx', 'application/octet-stream', 'file', bytes);
    const reader = await officeRouteReader(); const editor = await officeRouteEditor();
    const { h, tools, fake, backend, sources, inlineDelivered } = await codexWith({ attached: [item], hostReadFile: true, writeOnlyWriter: true, withSourceReader: true,
      capabilities: ['read', 'write'], hostFileTools: tools => { tools.setOfficeEditor(editor); return tools; } });
    h.assets.holdForUserRequest('codex-1', sources.map(source => source.assetId));
    try {
      await turn(backend, { userAttachments: [item], delegationContentSources: sources, receivedContentSources: sources.filter(source => source.mediaKind === 'binary') });
      const packet = fake.clientMessages.find(message => message.method === 'turn/start'); const inputText = JSON.stringify(packet.params.input);
      expect(inputText).toContain('original bytes are addressable'); expect(inputText).not.toContain('Actual Office 名称');
      expect(inlineDelivered.mock.calls.flatMap(call => call[0])).not.toContain(item.contentAssetId);
      (backend as any).hostReadToolsForTurn((backend as any).currentAccess()).setOfficeReader(reader);
      expect(JSON.parse((backend as any).threadDynamicToolSignature).documentSources).toBe(true);
      fake.toolCall('inspect_office', { source_ref: item.contentAssetId }, 'attachment-source'); const read = (await answer(fake, 'attachment-source')).result;
      expect(read.success, JSON.stringify(read)).toBe(true); const page = JSON.parse(read.contentItems[0].text); expect(page.source_sha256).toBe(sha(bytes));
      fake.toolCall('edit_office', { schema_version: 1, snapshot_ref: page.snapshot_ref, path: 'attachment-copy.docx',
        edits: [{ op: 'replace_text', target_ref: 'D1', find: 'Actual Office 名称', replace: 'Codex attachment result' }] }, 'attachment-edit');
      const edited = (await answer(fake, 'attachment-edit')).result; expect(edited.success, JSON.stringify(edited)).toBe(true);
      const zip = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'attachment-copy.docx')));
      expect(await zip.file('word/document.xml')!.async('string')).toContain('Codex attachment result');
      expect(tools.specs().some(tool => tool.function.name === 'read_file')).toBe(false);
    } finally { await backend.stop(50); await reader.dispose(); await h.assets.dispose(); }
  });
  it('preserves a saved Codex document thread without source_ref parameters and keeps its path reader usable', async () => {
    const reader = await officeRouteReader(); const { h, fake, backend } = await codexWith({ hostReadFile: true });
    const resets = vi.fn(); (backend as any).deps.onConversationReset = resets;
    const saved = JSON.parse((backend as any).dynamicToolSignature()); delete saved.documentSources; const signature = JSON.stringify(saved);
    backend.restore({ version: 3, backend: 'codex', hostTurnState: 'complete', messages: [{ codexThreadId: 'old-document-thread', codexDynamicTools: signature }] });
    await fs.writeFile(path.join(h.root, 'source.docx'), await officeRouteDocument());
    try {
      await turn(backend, {}); (backend as any).hostReadToolsForTurn((backend as any).currentAccess()).setOfficeReader(reader);
      expect(fake.clientMessages.some(message => message.method === 'thread/resume')).toBe(true); expect(fake.clientMessages.some(message => message.method === 'thread/start')).toBe(false);
      expect(resets).not.toHaveBeenCalled(); expect(backend.snapshot()?.messages[0]).toMatchObject({ codexDynamicTools: signature });
      fake.toolCall('inspect_office', { source_ref: 'content-1' }, 'old-source-ref'); const old = (await answer(fake, 'old-source-ref')).result;
      expect(old.success).toBe(false); expect(old.contentItems[0].text).toContain('New Model Conversation (keep chat)');
      fake.toolCall('inspect_office', { path: 'source.docx' }, 'retained-path'); const read = (await answer(fake, 'retained-path')).result;
      expect(read.success, JSON.stringify(read)).toBe(true); expect(resets).not.toHaveBeenCalled();
    } finally { await backend.stop(50); await reader.dispose(); await h.assets.dispose(); }
  });
  it.each(['act', 'plan', 'legacy-native-default'] as const)('O4 edits using the actual Codex Read surface and Write-only writer in %s', async mode => {
    const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const { h, tools, fake, backend } = await codexWith({ hostReadFile: true, writeOnlyWriter: true,
      capabilities: mode === 'legacy-native-default' ? [] : ['read', 'write'],
      hostFileTools: tools => { tools.setOfficeEditor(editor); return tools; } });
    const bytes = await officeRouteDocument(); await fs.writeFile(path.join(h.root, 'source.docx'), bytes);
    try {
      await turn(backend, { mode: mode === 'plan' ? 'plan' : 'act' }); (backend as any).hostReadToolsForTurn((backend as any).currentAccess()).setOfficeReader(reader);
      const offered = fake.clientMessages.find(message => message.method === 'thread/start').params.dynamicTools; expect(offered.some((tool: any) => tool.name === 'edit_office')).toBe(true);
      fake.toolCall('inspect_office', { path: 'source.docx' }, 'inspect-edit-source'); const captured = (await answer(fake, 'inspect-edit-source')).result;
      expect(captured.success, JSON.stringify(captured)).toBe(true); const snapshot = JSON.parse(captured.contentItems[0].text).snapshot_ref;
      fake.toolCall('edit_office', { schema_version: 1, snapshot_ref: snapshot, path: 'copy.docx', edits: [{ op: 'replace_text', target_ref: 'D1', find: 'Actual Office 名称', replace: 'Changed Office' }] }, 'edit');
      const result = (await answer(fake, 'edit')).result;
      if (mode === 'plan') { expect(result.success).toBe(false); expect(result.contentItems[0].text).toContain('Plan'); await expect(fs.stat(path.join(h.root, 'copy.docx'))).rejects.toMatchObject({ code: 'ENOENT' }); }
      else { expect(result.success, JSON.stringify(result)).toBe(true); const zip = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'copy.docx'))); expect(await zip.file('word/document.xml')!.async('string')).toContain('Changed Office');
        // v0.9.108 W2: Codex dynamicTools carry the tracked-change field and decision operations, and the default Word edit is tracked.
        const editTool = offered.find((tool: any) => tool.name === 'edit_office'); expect(editTool.inputSchema.properties.track_changes.type).toBe('boolean');
        expect(editTool.inputSchema.properties.edits.items.properties.op.enum).toEqual(expect.arrayContaining(['accept_revision', 'reject_revision'])); expect(result.contentItems[0].text).toContain('Tracked changes: recorded as Word revisions'); }
      expect(tools.specs().some(tool => tool.function.name === 'read_file')).toBe(false); expect(await fs.readFile(path.join(h.root, 'source.docx'))).toEqual(bytes);
    } finally { await backend.stop(50); await reader.dispose(); await h.assets.dispose(); }
  });
  it.each(['act', 'plan'] as const)('v0.9.108 edit_pdf reaches the actual Codex dynamic router with a Write-only writer in %s', async mode => {
    const editor = await pdfRouteEditor(); const { h, tools, fake, backend } = await codexWith({ hostReadFile: true, writeOnlyWriter: true, capabilities: ['read', 'write'],
      hostFileTools: tools => { tools.setPdfEditor(editor); return tools; } });
    const pdf = await makePdf([{ text: 'Codex page one' }, { text: 'Codex page two' }]); await fs.writeFile(path.join(h.root, 'in.pdf'), pdf);
    try {
      await turn(backend, { mode });
      const offered = fake.clientMessages.find(message => message.method === 'thread/start').params.dynamicTools; expect(offered.some((tool: any) => tool.name === 'edit_pdf')).toBe(true);
      fake.toolCall('edit_pdf', { schema_version: 1, destination: 'out.pdf', inputs: [{ path: 'in.pdf' }], operations: [{ op: 'reorder_pages', order: [2, 1] }] }, 'edit-pdf');
      const result = (await answer(fake, 'edit-pdf')).result;
      if (mode === 'plan') { expect(result.success).toBe(false); expect(result.contentItems[0].text).toContain('Plan'); await expect(fs.stat(path.join(h.root, 'out.pdf'))).rejects.toMatchObject({ code: 'ENOENT' }); }
      else {
        expect(result.success, JSON.stringify(result)).toBe(true); expect(result.contentItems[0].text).toContain('"kind":"pdf-edited"');
        const pages = await pdfTextPort.pages(await fs.readFile(path.join(h.root, 'out.pdf'))); expect(pages.map(items => items.map(item => item.str).join(''))).toEqual(['Codex page two', 'Codex page one']);
      }
      expect(tools.specs().some(tool => tool.function.name === 'read_file')).toBe(false); expect(await fs.readFile(path.join(h.root, 'in.pdf'))).toEqual(Buffer.from(pdf));
    } finally { await backend.stop(50); await h.assets.dispose(); }
  });
  it.each(['act', 'plan'] as const)('v0.9.108 view_pdf_pages is a Codex dynamic tool with Commands and is refused in %s Plan only', async mode => {
    let root = '';
    const { h, fake, backend } = await codexWith({ capabilities: ['read', 'write', 'execute'], hostFileTools: original => {
      root = (original as any).pathBase; const tools = new WorkspaceTools(root, new Set(['read', 'write', 'execute']), 'codex-1', undefined, new CommandPolicy('all'));
      tools.setPdfPageRasterPlatform(() => undefined); return tools;
    } });
    await fs.writeFile(path.join(h.root, 'in.pdf'), await makePdf([{ text: 'Page' }]));
    try {
      await turn(backend, { mode });
      expect(fake.clientMessages.find(message => message.method === 'thread/start').params.dynamicTools.some((tool: any) => tool.name === 'view_pdf_pages')).toBe(true);
      fake.toolCall('view_pdf_pages', { path: 'in.pdf', pages: '1' }, 'pages'); const result = (await answer(fake, 'pages')).result;
      if (mode === 'plan') { expect(result.success).toBe(false); expect(result.contentItems[0].text).toContain('Plan'); }
      else { expect(result.success, JSON.stringify(result)).toBe(true); expect(result.contentItems[0].text).toContain('platform-unsupported'); }
    } finally { await backend.stop(50); await h.assets.dispose(); }
  });
  it.each(['act', 'plan'] as const)('O4 inspects Office through the actual Codex dynamic router in %s', async mode => {
    const reader = await officeRouteReader(); const { h, fake, backend } = await codexWith({ hostReadFile: true });
    const input = await officeRouteDocument(); await fs.writeFile(path.join(h.root, 'source.docx'), input);
    try {
      await turn(backend, { mode }); (backend as any).hostReadToolsForTurn((backend as any).currentAccess()).setOfficeReader(reader);
      expect(fake.clientMessages.find(message => message.method === 'thread/start').params.dynamicTools.some((tool: any) => tool.name === 'inspect_office')).toBe(true);
      // v0.9.108 W1: the Word view parameter reaches Codex dynamicTools and is honoured there.
      expect(fake.clientMessages.find(message => message.method === 'thread/start').params.dynamicTools.find((tool: any) => tool.name === 'inspect_office').inputSchema.properties.view.enum).toEqual(['current', 'original', 'markup']);
      fake.toolCall('inspect_office', { path: 'source.docx', view: 'original' }, 'office-view'); const viewed = (await answer(fake, 'office-view')).result;
      expect(viewed.success, JSON.stringify(viewed)).toBe(true); expect(JSON.parse(viewed.contentItems[0].text).view).toBe('original');
      fake.toolCall('inspect_office', { path: 'source.docx' }, 'office'); const result = (await answer(fake, 'office')).result;
      expect(result.success, JSON.stringify(result)).toBe(true); const page = JSON.parse(result.contentItems[0].text);
      expect(officeRouteParagraph(page)).toMatchObject({ text: 'Actual Office 名称', selector: { snapshot_ref: page.snapshot_ref } });
      const signature = JSON.parse((backend as any).threadDynamicToolSignature); delete signature.inspectOffice;
      (backend as any).threadDynamicToolSignature = JSON.stringify(signature);
      fake.toolCall('inspect_office', { path: 'source.docx' }, 'old-office'); const old = (await answer(fake, 'old-office')).result;
      expect(old.success).toBe(false); expect(old.contentItems[0].text).toContain('New Model Conversation (keep chat)');
      expect(await fs.readFile(path.join(h.root, 'source.docx'))).toEqual(input);
    } finally { await backend.stop(50); await reader.dispose(); await h.assets.dispose(); }
  });
  it('keeps the agent workbook snapshot usable when the real App Server starts another turn', async () => {
    const reader = await workbookRouteReader(); const { h, tools, fake, backend } = await codexWith({ hostReadFile: true,
      hostFileTools: tools => { tools.setWorkbookReader(reader); return tools; } });
    await fs.writeFile(path.join(h.root, 'table.xlsx'), await typedXlsxFixture());
    try {
      await turn(backend, {}); fake.toolCall('read_workbook', { path: 'table.xlsx', operation: 'range', range: 'H1' }, 'shared-first');
      const first = (await answer(fake, 'shared-first')).result; expect(first.success, JSON.stringify(first)).toBe(true);
      const snapshot = JSON.parse(first.contentItems[0].text).snapshot_ref;
      fake.completeTurn(); await tick(); await tick(); await turn(backend, {});
      fake.toolCall('read_workbook', { path: 'table.xlsx', operation: 'range', range: 'K1' }, 'shared-next');
      const next = (await answer(fake, 'shared-next')).result; expect(next.success, JSON.stringify(next)).toBe(true);
      expect(JSON.parse(next.contentItems[0].text)).toMatchObject({ snapshot_ref: snapshot, prepared_fragments: [{ record: { value: { kind: 'unresolved' } } }] });
      // The persistent writer can reach the same data custody without gaining authority to read arbitrary paths.
      const writerRead = await tools.run('read_workbook', { path: 'table.xlsx', operation: 'range', range: 'H1' });
      expect(JSON.parse(writerRead.output).snapshot_ref).toBe(snapshot);
    } finally { await backend.stop(); await reader.dispose(); await h.assets.dispose(); }
  });
  it.each(['act', 'plan'] as const)('O2 reads bounded CSV through App Server in %s and preserves an old conversation without adding the tool', async mode => {
    const held: string[] = []; const receipts: any[] = []; const reader = await workbookRouteReader(); const { h, backend, fake } = await codexWith({ hostReadFile: true, onContentReceipt: receipt => receipts.push(receipt),
      requestBoundary: async (kind: string, detail: { tool?: string }) => { if (kind === 'effect') { held.push(detail.tool ?? ''); return 'stopped'; } return 'proceed'; } });
    const text = '😀\n"'.repeat(4000); const original = '"' + text.replaceAll('"', '""') + '",0'; await fs.writeFile(path.join(h.root, 'table.csv'), original);
    try {
      await turn(backend, { mode }); (backend as any).hostReadToolsForTurn((backend as any).currentAccess()).setWorkbookReader(reader);
      expect(fake.clientMessages.find(message => message.method === 'thread/start').params.dynamicTools.some((tool: any) => tool.name === 'read_workbook')).toBe(true);
      const pages: WorkbookPage[] = []; let cursor: string | undefined;
      do {
        const id = `csv-${pages.length}`; fake.toolCall('read_workbook', { path: 'table.csv', operation: 'range', ...(cursor ? { cursor } : {}) }, id);
        const response = (await answer(fake, id)).result; expect(response.success, JSON.stringify(response)).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(64000); const output = response.contentItems[0].text;
        expect(output).not.toContain('truncated'); const page = JSON.parse(output) as WorkbookPage; pages.push(page); cursor = page.next_cursor ?? undefined;
        if (pages.length > 20) throw new Error('CSV dynamic route did not progress');
      } while (cursor);
      expect(pages.length).toBeGreaterThan(1); const cells = pages.flatMap(page => page.prepared_fragments);
      expect(cells.filter(cell => cell.cell === 'A1').map(cell => cell.text).join('')).toBe(text); expect(cells.filter(cell => cell.cell === 'B1').map(cell => cell.text)).toEqual(['0']);
      const delivery = (backend as any).hostReadTools.workbookDeliveryFacts();
      expect(delivery).toHaveLength(pages.length); expect(delivery.every((fact: any) => fact.state === 'payload-submitted' && fact.route === 'codex' && fact.observed_units.length === 0)).toBe(true);
      expect(new Set(delivery.flatMap((fact: any) => fact.submitted_units))).toEqual(new Set(['cell:A1', 'cell:B1']));
      expect(receipts.filter(receipt => receipt.contentClass === 'workbook' && receipt.action === 'payload-submitted')).toHaveLength(pages.length);
      expect(receipts.every(receipt => receipt.observedUnits === 0)).toBe(true);
      await fs.writeFile(path.join(h.root, 'table.xlsx'), await typedXlsxFixture());
      fake.toolCall('read_workbook', { path: 'table.xlsx', operation: 'range', range: 'K1' }, 'xlsx-cache');
      const xlsx = (await answer(fake, 'xlsx-cache')).result; expect(xlsx.success, JSON.stringify(xlsx)).toBe(true);
      expect(JSON.parse(xlsx.contentItems[0].text).prepared_fragments[0].record.value).toMatchObject({ kind: 'unresolved', reason: 'formula-cache-missing' });
      const group = 'A' + '😀\n"'.repeat(10000); const quoted = '"' + group.replaceAll('"', '""') + '"';
      await fs.writeFile(path.join(h.root, 'computed.csv'), `team,amount\n${quoted},0.1\n${quoted},0.2\nB,9007199254740993\nB,1`);
      fake.toolCall('read_workbook', { path: 'computed.csv' }, 'compute-source'); const captured = (await answer(fake, 'compute-source')).result;
      const computation = new WorkbookRecordCollector(); let computeArgs: Record<string, unknown> = workbookSumPlan(JSON.parse(captured.contentItems[0].text).snapshot_ref); let computePages = 0;
      for (; ; computePages++) {
        expect(computePages).toBeLessThan(30); const id = `compute-${computePages}`; fake.toolCall('transform_workbook', computeArgs, id);
        const result = (await answer(fake, id)).result; expect(result.success, JSON.stringify(result)).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(64000); const page = JSON.parse(result.contentItems[0].text); computation.add(page);
        if (!page.next_cursor) break; computeArgs = { operation: 'read', data_ref: page.data_ref, cursor: page.next_cursor };
      }
      expect(computePages).toBeGreaterThan(0); const totals = computation.records().filter(item => item.kind === 'row'); expect(totals).toHaveLength(2);
      expect(totals.find(item => item.record.cells.team.text === group).record.cells.total.exact).toEqual({ numerator: '3', denominator: '10' });
      const computedDelivery = (backend as any).hostReadTools.workbookDeliveryFacts().filter((fact: any) => fact.scope.sourceVersion.startsWith('transformation-'));
      expect(new Set(computedDelivery.flatMap((fact: any) => fact.submitted_units)).size).toBe(totals.reduce((sum, item) => sum + Object.keys(item.record.cells).length, 0));
      expect(computedDelivery.every((fact: any) => !fact.observed_units.length && fact.submitted_units.every((unit: string) => unit.startsWith('table-cell:')))).toBe(true);
      const signature = JSON.parse((backend as any).threadDynamicToolSignature); delete signature.readWorkbook; (backend as any).threadDynamicToolSignature = JSON.stringify(signature);
      fake.toolCall('read_workbook', { path: 'table.csv' }, 'old-csv'); const old = (await answer(fake, 'old-csv')).result;
      expect(old.success).toBe(false); expect(old.contentItems[0].text).toContain('New Model Conversation (keep chat)');
      expect(await fs.readFile(path.join(h.root, 'table.csv'), 'utf8')).toBe(original);
      expect(held).toEqual([]);
    } finally { await backend.stop(); await reader.dispose(); await h.assets.dispose(); }
  });
  it('O3 advertises and writes editable PPTX through App Server; a preserved old thread cannot gain the tool', async () => {
    const renderer = await presentationRouteRenderer(); const reader = await workbookRouteReader(); const wordRenderer = await documentRouteRenderer();
    const outside = await temporaryFolder('unode-codex-binding-source-'); const sourcePath = path.join(outside, 'table.csv'); await fs.writeFile(sourcePath, COMPUTE_CSV);
    const scope = new SessionLocalReadScopeConsent(async () => false);
    await scope.requestPathAccess(sourcePath, { requestId: 'r1', isCurrent: () => true }, async () => ({ permission: 'read', lifetime: 'session' }));
    const { h, fake, backend, sources, id } = await codexWith({ hostReadFile: true, writeOnlyWriter: true, attached: [attachment('pixels.png', 'image/png', 'image', PRESENTATION_PNG)],
      readAccess: { livePathAccess: () => scope.pathAccessFor('r1') },
      hostFileTools: tools => { tools.setPresentationRenderer(renderer); tools.setWorkbookReader(reader); tools.setDocumentRenderer(wordRenderer); return tools; } });
    const events: any[] = []; backend.onEvent(event => events.push(event));
    try {
      await turn(backend, { delegationContentSources: sources });
      expect(fake.clientMessages.find(message => message.method === 'thread/start').params.dynamicTools.some((tool: any) => tool.name === 'write_presentation')).toBe(true);
      const input = presentationWithImage(id);
      fake.toolCall('write_presentation', { ...input, draft: 'deck', deck: { ...input.deck, title: 'A'.repeat(75000) } }, 'ppt-part');
      expect((await answer(fake, 'ppt-part')).result.success).toBe(true); expect(existsSync(path.join(h.root, input.path))).toBe(false);
      fake.toolCall('write_presentation', { ...input, draft: 'deck', final: true, deck: { ...input.deck, slides: [] } }, 'ppt');
      expect((await answer(fake, 'ppt')).result.success).toBe(true);
      const bytes = await fs.readFile(path.join(h.root, 'out/result.pptx')); await assertEditablePresentation(bytes);
      await assertOriginalPngEmbedded(bytes);
      expect(events.find(event => event.kind === 'tool_result' && event.presentationWrite?.code === 'written')).toMatchObject({ presentationWrite: { code: 'written', receipt: { sha256: sha(bytes) } } });
      expect([...(backend as any).turnEvidence.changedFiles]).toContain('out/result.pptx');
      fake.toolCall('read_workbook', { path: sourcePath }, 'binding-source');
      const snapshot = JSON.parse((await answer(fake, 'binding-source')).result.contentItems[0].text).snapshot_ref;
      fake.toolCall('transform_workbook', workbookSumPlan(snapshot), 'binding-compute');
      const computed = (await answer(fake, 'binding-compute')).result;
      fake.toolCall('write_presentation', boundPresentationInput(JSON.parse(computed.contentItems[0].text).transformation_ref), 'binding-save');
      expect((await answer(fake, 'binding-save')).result.success).toBe(true); await assertBoundPresentation(await fs.readFile(path.join(h.root, 'out/bound.pptx')));
      fake.completeTurn(); await tick(); await tick(); await turn(backend, {});
      // No source read in this request: the writer must obtain the new turn's actual read surface lazily.
      fake.toolCall('write_presentation', { ...boundPresentationInput(JSON.parse(computed.contentItems[0].text).transformation_ref), path: 'out/next.pptx' }, 'binding-next');
      expect((await answer(fake, 'binding-next')).result.success).toBe(true); await assertBoundPresentation(await fs.readFile(path.join(h.root, 'out/next.pptx')));
      fake.toolCall('write_document', boundDocumentInput(JSON.parse(computed.contentItems[0].text).transformation_ref), 'binding-word');
      expect((await answer(fake, 'binding-word')).result.success).toBe(true); await assertBoundDocument(await fs.readFile(path.join(h.root, 'out/bound.docx')));
      (backend as any).deps.hostReadFile = false;
      fake.toolCall('write_presentation', { ...boundPresentationInput(JSON.parse(computed.contentItems[0].text).transformation_ref), path: 'out/off.pptx' }, 'binding-off');
      const off = (await answer(fake, 'binding-off')).result; expect(off.success).toBe(false); expect(off.contentItems[0].text).toContain('Read is Off'); expect(existsSync(path.join(h.root, 'out/off.pptx'))).toBe(false);
      fake.toolCall('write_document', { ...boundDocumentInput(JSON.parse(computed.contentItems[0].text).transformation_ref), path: 'out/off.docx' }, 'binding-word-off');
      const wordOff = (await answer(fake, 'binding-word-off')).result; expect(wordOff.success).toBe(false); expect(wordOff.contentItems[0].text).toContain('Read is Off'); expect(existsSync(path.join(h.root, 'out/off.docx'))).toBe(false);
      (backend as any).threadDynamicToolSignature = JSON.stringify({ saveAttachment: true });
      fake.toolCall('write_presentation', presentationInput('out/old.pptx'), 'old-ppt');
      expect((await answer(fake, 'old-ppt')).result.success).toBe(false);
      expect(existsSync(path.join(h.root, 'out/old.pptx'))).toBe(false);
    } finally { await backend.stop(); await reader.dispose(); await h.assets.dispose(); }
  });
  it('sends PDF fallback through the dynamic tool and emits one runtime reminder', async () => {
    const renderer = await documentRouteRenderer();
    const { backend, fake } = await codexWith({ hostFileTools: tools => { tools.setDocumentRenderer(renderer); return tools; } });
    const events: any[] = []; backend.onEvent(event => events.push(event));
    try {
      await turn(backend, {});
      fake.toolCall('write_document', documentInput('pdf', '\u0627'), 'pdf-fallback');
      const response = await answer(fake, 'pdf-fallback');
      expect(response.result.success).toBe(false);
      expect(JSON.stringify(response)).toContain('write the same document now with format docx');
      expect(JSON.stringify(response)).toContain('Export as PDF');
      expect(events.filter(event => event.kind === 'runtime_notice')).toEqual([
        { kind: 'runtime_notice', text: expect.stringContaining('asked the agent to save it as Word') },
      ]);
    } finally { await backend.stop(); }
  });
  it('v0.9.102 field fix 4: a document the host wrote is this turn\'s changed file, and its receipt names the full path written', async () => {
    const renderer = await documentRouteRenderer();
    const { h, fake, backend } = await codexWith({ hostFileTools: tools => { tools.setDocumentRenderer(renderer); return tools; } });
    try {
      await turn(backend, {});
      fake.toolCall('write_document', documentInput('docx'), 'document-path');
      const response = await answer(fake, 'document-path'); expect(response.result.success).toBe(true);
      expect(response.result.contentItems[0].text).toContain(
        `Document written: out/result.docx\nFull path written: ${realpathSync.native(path.join(h.root, 'out/result.docx'))}\n`);
      // As a native file change is: the file reaches the task's evidence, so a required output written here is seen.
      expect([...(backend as any).turnEvidence.changedFiles]).toEqual(['out/result.docx']);
    } finally { await backend.stop(); }
  });
  it('keeps the 64 KiB argument cap on non-document dynamic tools', async () => {
    const next = await codexWith();
    try {
      await turn(next.backend, {});
      next.fake.toolCall('save_attachment', { asset_id: 'large', path: 'x'.repeat(70_000) }, 'large-other');
      expect(JSON.stringify(await answer(next.fake, 'large-other'))).toContain('64 KiB host limit');
    } finally { await next.backend.stop(); }
  });
  it.each(['docx', 'pdf'] as const)('registers, writes %s and returns the same read-back host receipt', async format => {
    const renderer = await documentRouteRenderer();
    const { h, fake, backend } = await codexWith({ hostFileTools: tools => { tools.setDocumentRenderer(renderer); return tools; } });
    const events: any[] = []; backend.onEvent(event => events.push(event));
    try {
      await turn(backend, {});
      const thread = fake.clientMessages.find(message => message.method === 'thread/start');
      expect(thread.params.dynamicTools.find((tool: any) => tool.name === 'write_document')).toEqual({ name: 'write_document',
        description: WRITE_DOCUMENT_SPEC.function.description, inputSchema: WRITE_DOCUMENT_SPEC.function.parameters });
      expect(backend.snapshot()?.messages[0]).toMatchObject({ codexDynamicTools: expect.stringContaining('"writeDocument":true') });
      fake.toolCall('write_document', documentInput(format, format === 'docx' ? 'مرحبا' : 'CONTRACT 123'), 'document-1');
      const response = await answer(fake, 'document-1'); expect(response.result.success).toBe(true);
      const bytes = await fs.readFile(path.join(h.root, `out/result.${format}`));
      expect(bytes.subarray(0, 4).toString('hex')).toBe(format === 'docx' ? '504b0304' : '25504446');
      expect(response.result.contentItems[0].text).toContain(sha(bytes));
      expect(events.find(event => event.kind === 'tool_result')).toMatchObject({ outcome: { status: 'success', observedBy: 'host' },
        documentWrite: { code: 'written', receipt: { format, sha256: sha(bytes), bytes: bytes.length } } });
      if (format === 'docx') expect(events.find(event => event.kind === 'tool_result')).toMatchObject({ summary: expect.stringContaining('reader layout unverified') });
      (backend as any).threadDynamicToolSignature = JSON.stringify({ saveAttachment: true });
      fake.toolCall('write_document', { ...documentInput(format), path: `old.${format}` }, 'old-thread');
      expect((await answer(fake, 'old-thread')).result.success).toBe(false);
      expect(existsSync(path.join(h.root, `old.${format}`))).toBe(false);
    } finally { await backend.stop(); }
  });
  it('does not offer it without a renderer and refuses it in Plan mode', async () => {
    const old = await codexWith();
    try { await turn(old.backend, {}); expect(old.fake.clientMessages.find(message => message.method === 'thread/start').params.dynamicTools.some((tool: any) => tool.name === 'write_document')).toBe(false); }
    finally { await old.backend.stop(); }
    const renderer = await documentRouteRenderer();
    const next = await codexWith({ hostFileTools: tools => { tools.setDocumentRenderer(renderer); return tools; } });
    try { await turn(next.backend, { mode: 'plan' }); next.fake.toolCall('write_document', documentInput('docx'), 'plan-doc');
      expect((await answer(next.fake, 'plan-doc')).result.success).toBe(false);
      expect(existsSync(path.join(next.h.root, 'out/result.docx'))).toBe(false);
    } finally { await next.backend.stop(); }
  });
  // v0.9.99: no 1 MiB document argument ceiling; a draft part writes nothing, so a request limit holds only the final part.
  it('accepts a write_document argument over the former 1 MiB ceiling, and holds only the final draft part at a request limit', async () => {
    const renderer = await documentRouteRenderer(); const held: string[] = [];
    const next = await codexWith({ hostFileTools: tools => { tools.setDocumentRenderer(renderer); return tools; },
      requestBoundary: async (_kind: string, detail: { tool?: string }) => { held.push(detail?.tool ?? ''); return held.length > 1 ? 'stopped' : 'proceed'; } });
    try {
      await turn(next.backend, {}); const input = documentInput('docx');
      input.document.blocks = Array.from({ length: 160 }, (_, i) => ({ type: 'paragraph', content: [{ text: `P${i} ${'A'.repeat(7500)}` }] })) as any;
      expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(1_048_576);
      next.fake.toolCall('write_document', input, 'huge-doc'); expect((await answer(next.fake, 'huge-doc')).result.success).toBe(true);
      expect(existsSync(path.join(next.h.root, input.path))).toBe(true); expect(held).toEqual(['write_document']);
      const part = { ...documentInput('docx'), path: 'out/parts.docx', draft: 'parts' };
      next.fake.toolCall('write_document', part, 'part-1'); expect((await answer(next.fake, 'part-1')).result.success).toBe(true);
      expect(held).toEqual(['write_document']);
      next.fake.toolCall('write_document', { ...part, final: true }, 'part-final');
      expect((await answer(next.fake, 'part-final')).result.success).toBe(false);
      expect(held).toEqual(['write_document', 'write_document']); expect(existsSync(path.join(next.h.root, 'out/parts.docx'))).toBe(false);
    } finally { await next.backend.stop(); }
  }, 60_000);
  it('accepts a document over the old generic 64 KiB tool bound, and retains the coordinator execution check', async () => {
    const renderer = await documentRouteRenderer();
    const next = await codexWith({ hostFileTools: tools => { tools.setDocumentRenderer(renderer); return tools; } });
    try {
      await turn(next.backend, {}); const input = documentInput('docx');
      input.document.blocks = [{ type: 'paragraph', content: Array.from({ length: 10 }, () => ({ text: 'A'.repeat(7500) })) }] as any;
      expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(65536);
      next.fake.toolCall('write_document', input, 'large-doc'); expect((await answer(next.fake, 'large-doc')).result.success).toBe(true);
    } finally { await next.backend.stop(); }
    const team = { listTools: async () => [], hasTeammates: () => true, currentCoordinatorTaskAttempt: () => ({}), canCoordinatorExecute: () => false };
    const pm = await codexWith({ hostFileTools: tools => { tools.setDocumentRenderer(renderer); return tools; }, teamMcpBridge: team });
    try { await turn(pm.backend, {}); pm.fake.toolCall('write_document', documentInput('docx'), 'pm-doc');
      expect((await answer(pm.fake, 'pm-doc')).result.success).toBe(false);
      expect(existsSync(path.join(pm.h.root, 'out/result.docx'))).toBe(false);
    } finally { await pm.backend.stop(); }
  });
  it('keeps a pre-document thread and gives real steps for opting into a new document conversation', async () => {
    const old = await codexWith(); let snapshot;
    try { await turn(old.backend, {}); snapshot = { ...old.backend.snapshot()!, version: 3 as const,
      backend: 'codex' as const, hostTurnState: 'complete' as const }; }
    finally { await old.backend.stop(); }
    const renderer = await documentRouteRenderer();
    const next = await codexWith({ hostFileTools: tools => { tools.setDocumentRenderer(renderer); return tools; } });
    try {
      expect(next.backend.restore(snapshot)).toBe(true); await turn(next.backend, {});
      expect(next.fake.clientMessages.filter(message => message.method === 'thread/resume')).toHaveLength(1);
      expect(next.fake.clientMessages.filter(message => message.method === 'thread/start')).toHaveLength(0);
      expect(next.fake.clientMessages.filter(message => message.method === 'turn/start')).toHaveLength(1);
      expect(JSON.stringify(next.backend.snapshot()?.messages[0])).not.toContain('writeDocument');
      expect(JSON.stringify(next.fake.clientMessages.find(message => message.method === 'turn/start'))).toContain('New Model Conversation (keep chat)');
      next.fake.toolCall('write_document', documentInput('docx'), 'old-doc');
      const refused = await answer(next.fake, 'old-doc'); expect(refused.result.success).toBe(false);
      expect(refused.result.contentItems[0].text).toContain('1. Select this agent');
      expect(refused.result.contentItems[0].text).toContain('Ctrl+Shift+P');
      expect(existsSync(path.join(next.h.root, 'out/result.docx'))).toBe(false);
    } finally { await next.backend.stop(); }
  });
});

describe('save_attachment as a Codex dynamic tool (review resolution §2)', () => {
  it('offers the one description and input, and saves byte for byte through the host tools', async () => {
    const { h, sources, fake, backend, id } = await codexWith();
    try {
      await turn(backend, { delegationContentSources: sources });
      const offered = fake.clientMessages.find((message) => message.method === 'thread/start').params.dynamicTools;
      const tool = offered.find((candidate: any) => candidate.name === 'save_attachment');
      expect(tool).toEqual({
        name: 'save_attachment',
        description: SAVE_ATTACHMENT_DESCRIPTION,
        inputSchema: { type: 'object', properties: { asset_id: expect.any(Object), path: expect.any(Object) }, required: ['asset_id', 'path'] },
      });
      fake.toolCall('save_attachment', { asset_id: id, path: 'assets/logo.png' }, 'save-1');
      const response = await answer(fake, 'save-1');
      expect(response.result.success).toBe(true);
      expect(response.result.contentItems[0].text).toContain(`Saved attachment ${id} to assets/logo.png as a new file: ${PNG.length} bytes, SHA-256 ${sha(PNG)}`);
      expect((await fs.readFile(path.join(h.root, 'assets', 'logo.png'))).equals(PNG)).toBe(true);
      // The thread records that it was started with the tool, so a thread without it is not resumed as if it had it.
      expect(backend.snapshot()?.messages[0]).toMatchObject({ codexDynamicTools: expect.stringContaining('"saveAttachment":true') });
    } finally {
      await backend.stop();
    }
  });

  it('refuses in Plan mode', async () => {
    const { h, sources, fake, backend, id } = await codexWith();
    try {
      await turn(backend, { mode: 'plan', delegationContentSources: sources });
      fake.toolCall('save_attachment', { asset_id: id, path: 'plan.png' }, 'plan-1');
      const planned = await answer(fake, 'plan-1');
      expect(planned.result.success).toBe(false);
      expect(planned.result.contentItems[0].text).toMatch(/save_attachment is unavailable in Plan mode/);
      expect(existsSync(path.join(h.root, 'plan.png'))).toBe(false);
    } finally {
      await backend.stop();
    }
  });

  it('saves nothing for an attachment the turn did not grant', async () => {
    const { h, fake, backend, id } = await codexWith();
    try {
      await turn(backend, {});
      fake.toolCall('save_attachment', { asset_id: id, path: 'ungranted.png' }, 'ungranted-1');
      const ungranted = await answer(fake, 'ungranted-1');
      expect(ungranted.result.success).toBe(false);
      expect(ungranted.result.contentItems[0].text).toMatch(/asset-unavailable/);
      expect(existsSync(path.join(h.root, 'ungranted.png'))).toBe(false);
    } finally {
      await backend.stop();
    }
  });

  it('is not offered without the host tools, and leaves the thread\'s tool signature as it was', async () => {
    const { fake, backend } = await codexWith({ hostFileTools: () => undefined });
    try {
      await turn(backend, {});
      const offered = fake.clientMessages.find((message) => message.method === 'thread/start').params.dynamicTools ?? [];
      expect(offered.map((candidate: any) => candidate.name)).not.toContain('save_attachment');
      expect(JSON.stringify(backend.snapshot()?.messages[0] ?? {})).not.toContain('saveAttachment');
    } finally {
      await backend.stop();
    }
  });

  it('stopping the agent retires the host tools', async () => {
    const { h, sources, tools, backend, id } = await codexWith();
    await turn(backend, { delegationContentSources: sources });
    await backend.stop();
    expect(await tools.run('save_attachment', { asset_id: id, path: 'logo.png' })).toMatchObject({ attachmentSave: { code: 'interrupted' } });
    expect(existsSync(path.join(h.root, 'logo.png'))).toBe(false);
  });

  // v0.9.99 (B15): with no contract in force, a coordinator with teammates saves under its own permissions, with the
  // delegation reminder; a contract it filed that does not cover the save still refuses it.
  it('follows the coordinator contract rule when the agent coordinates teammates', async () => {
    let attempt: unknown = { contractId: 'contract-1' };
    const team = {
      async listTools() { return []; },
      async callTool() { return ''; },
      hasTeammates: () => true,
      currentCoordinatorTaskAttempt: () => attempt,
      canCoordinatorExecute: () => false,
    };
    const { h, sources, fake, backend, id } = await codexWith({ teamMcpBridge: team });
    try {
      await turn(backend, { delegationContentSources: sources });
      fake.toolCall('save_attachment', { asset_id: id, path: 'logo.png' }, 'pm-1');
      const response = await answer(fake, 'pm-1');
      expect(response.result.success).toBe(false);
      expect(response.result.contentItems[0].text).toMatch(/outside the task contract you filed/);
      expect(existsSync(path.join(h.root, 'logo.png'))).toBe(false);
      attempt = undefined;
      fake.toolCall('save_attachment', { asset_id: id, path: 'logo.png' }, 'pm-2');
      const own = await answer(fake, 'pm-2');
      expect(own.result.success).toBe(true);
      expect(own.result.contentItems[0].text).toContain('[host reminder] You have teammates.');
      expect((await fs.readFile(path.join(h.root, 'logo.png'))).equals(PNG)).toBe(true);
    } finally {
      await backend.stop();
    }
  });
});

// v0.9.99 (A11): a PDF a Codex agent cannot take no longer fails the whole turn. The turn goes to App Server without
// it; the model is told it did not get the PDF, never that it was read, and is pointed at the host tools that can
// still reach it; the user gets one notice line. Real content store, host file tools and save path.
describe('a Codex turn with a PDF attachment continues without it (v0.9.99)', () => {
  const pdf = () => attachment('board-pack.pdf', 'application/pdf', 'pdf', PDF);
  const sentText = (fake: ReturnType<typeof fakeAppServer>) =>
    fake.clientMessages.find((message) => message.method === 'turn/start')?.params.input[0].text as string;

  it('sends the turn, names the PDF as not delivered, and the named save and read path works', async () => {
    const attached = [pdf()];
    const { h, sources, fake, backend, id } = await codexWith({ attached, hostReadFile: true });
    const events: any[] = []; backend.onEvent((event) => events.push(event));
    try {
      await turn(backend, { userAttachments: attached, delegationContentSources: sources });
      const text = sentText(fake);
      expect(text).toContain('[attachments not delivered]');
      expect(text).toContain('- board-pack.pdf: Codex CLI does not take PDF files.');
      expect(text).toContain('Do not say you read or reviewed them.');
      expect(text).toContain('save it into the workspace with save_attachment');
      expect(text).toContain('read_file');
      expect(fake.clientMessages.find((message) => message.method === 'turn/start').params.input).toHaveLength(1);
      // Never reported as sent: the turn's delivery receipt carries no user attachment.
      expect(events.filter((event) => event.kind === 'turn_input_delivered').map((event) => event.userAttachments)).toEqual([[]]);
      expect(events.filter((event) => event.kind === 'runtime_notice')).toEqual([{ kind: 'runtime_notice',
        text: expect.stringMatching(/^The agent did not receive board-pack\.pdf: Codex CLI does not take PDF files\. The turn continues without it\./) }]);
      expect(events.some((event) => event.kind === 'turn_complete')).toBe(false);
      // The path the model was given: the existing save tool writes the attached bytes, and read_file is offered.
      const offered = fake.clientMessages.find((message) => message.method === 'thread/start').params.dynamicTools.map((tool: any) => tool.name);
      expect(offered).toEqual(expect.arrayContaining(['save_attachment', 'read_file']));
      fake.toolCall('save_attachment', { asset_id: id, path: 'board-pack.pdf' }, 'save-pdf');
      expect((await answer(fake, 'save-pdf')).result.success).toBe(true);
      expect((await fs.readFile(path.join(h.root, 'board-pack.pdf'))).equals(PDF)).toBe(true);
    } finally {
      await backend.stop();
    }
  });

  it('without a tool that can read it, tells the model to ask the user instead of pointing at a tool it lacks', async () => {
    const attached = [pdf()];
    const { sources, fake, backend } = await codexWith({ attached, hostFileTools: () => undefined });
    try {
      await turn(backend, { userAttachments: attached, delegationContentSources: sources });
      const text = sentText(fake);
      expect(text).toContain('- board-pack.pdf: Codex CLI does not take PDF files.');
      expect(text).toContain('You have no tool here that can read a PDF.');
      expect(text).not.toContain('save_attachment using');
    } finally {
      await backend.stop();
    }
  });

  it('in Plan mode, where saving is refused, does not point at save_attachment', async () => {
    const attached = [pdf()];
    const { sources, fake, backend } = await codexWith({ attached, hostReadFile: true });
    try {
      await turn(backend, { userAttachments: attached, delegationContentSources: sources, mode: 'plan' });
      expect(sentText(fake)).toContain('You have no tool here that can read a PDF.');
    } finally {
      await backend.stop();
    }
  });
});

describe('v0.9.108 workbook writers through the actual Codex dynamic router', () => {
  it.each(['act', 'plan'] as const)('offers edit_workbook/write_workbook and edits an inspected workbook in %s', async mode => {
    const reader = await workbookRouteReader(); const editor = await workbookRouteEditor();
    const { h, tools, fake, backend } = await codexWith({ hostReadFile: true, writeOnlyWriter: true, capabilities: ['read', 'write'],
      hostFileTools: tools => { tools.setWorkbookEditor(editor); return tools; } });
    const bytes = await workbookFixture(); await fs.writeFile(path.join(h.root, 'book.xlsx'), bytes);
    try {
      await turn(backend, { mode }); (backend as any).hostReadToolsForTurn((backend as any).currentAccess()).setWorkbookReader(reader);
      const offered = fake.clientMessages.find(message => message.method === 'thread/start').params.dynamicTools;
      expect(offered.some((tool: any) => tool.name === 'edit_workbook')).toBe(true); expect(offered.some((tool: any) => tool.name === 'write_workbook')).toBe(true);
      fake.toolCall('read_workbook', { path: 'book.xlsx' }, 'inspect-book'); const inspected = (await answer(fake, 'inspect-book')).result;
      expect(inspected.success, JSON.stringify(inspected)).toBe(true); const snapshot = JSON.parse(inspected.contentItems[0].text).snapshot_ref;
      fake.toolCall('edit_workbook', { schema_version: 1, snapshot_ref: snapshot, path: 'copy.xlsx', edits: [{ op: 'set_formulas', sheet_id: 'sheet-1', cells: { E1: 'A1+B1' } }] }, 'edit-book');
      const result = (await answer(fake, 'edit-book')).result;
      if (mode === 'plan') { expect(result.success).toBe(false); expect(result.contentItems[0].text).toContain('Plan'); await expect(fs.stat(path.join(h.root, 'copy.xlsx'))).rejects.toMatchObject({ code: 'ENOENT' }); }
      else {
        expect(result.success, JSON.stringify(result)).toBe(true); expect(result.contentItems[0].text).toContain('Recalculated: no.');
        const zip = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'copy.xlsx'))); expect(await zip.file('xl/worksheets/sheet1.xml')!.async('string')).toContain('<c r="E1"><f>A1+B1</f></c>');
      }
      expect(tools.specs().some(tool => tool.function.name === 'read_file')).toBe(false); expect(await fs.readFile(path.join(h.root, 'book.xlsx'))).toEqual(bytes);
      const signature = JSON.parse((backend as any).threadDynamicToolSignature); delete signature.workbookWrite; (backend as any).threadDynamicToolSignature = JSON.stringify(signature);
      fake.toolCall('write_workbook', { schema_version: 1, path: 'new.xlsx', sheets: [{ name: 'A', rows: [[1]] }] }, 'old-thread');
      const old = (await answer(fake, 'old-thread')).result; expect(old.success).toBe(false); expect(old.contentItems[0].text).toContain(mode === 'plan' ? 'Plan' : 'New Model Conversation (keep chat)');
    } finally { await backend.stop(50); await reader.dispose(); await h.assets.dispose(); }
  });
});

describe('v0.9.108 recalculate_workbook through the actual Codex dynamic tools', () => {
  it('offers it to a reading writer with Commands and records it in the thread signature', async () => {
    const { h, fake, backend } = await codexWith({ hostReadFile: true, writerCapabilities: ['write', 'execute'], capabilities: ['read', 'write', 'execute'] });
    try {
      await turn(backend, {});
      const offered = fake.clientMessages.find(message => message.method === 'thread/start').params.dynamicTools;
      expect(offered.some((tool: any) => tool.name === 'recalculate_workbook')).toBe(true);
      expect(JSON.parse((backend as any).threadDynamicToolSignature).workbookRecalc).toBe(true);
    } finally { await backend.stop(50); await h.assets.dispose(); }
  });
});
