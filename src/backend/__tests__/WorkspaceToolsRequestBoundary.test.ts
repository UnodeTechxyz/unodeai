import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceTools } from '../WorkspaceTools';
import { UnodeSearchHost } from '../UnodeSearchHost';
import { asProvider } from './shellFixtures';
import { CommandPolicy } from '../CommandPolicy';
import { MessageBus } from '../../bus/MessageBus';
import type { Message } from '../../types';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { PNG } from './attachmentSaveFixtures';
import { renderDocx, type DocumentZip } from '../../content/document/DocxRenderer';
import { presentationInput, presentationRouteRenderer } from './presentationRouteFixtures';
import { officeRouteDocument, officeRouteEditor, officeRouteReader } from './officeInventoryRouteFixtures';
import { workbookRouteEditor, workbookRouteReader } from './workbookRouteFixtures';
import { workbookFixture } from '../../office/__tests__/workbookEditFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';
import { pdfRouteEditor } from './pdfRouteFixtures';
import { makePdf } from '../../office/pdf/__tests__/pdfFixtures';
import type { OfficeReader } from '../../office/OfficeReader';
import {
  GOVERNED_WORKSPACE_TOOLS,
  isGovernedWorkspaceTool,
  REQUEST_LIMIT_STOPPED_REFUSAL,
  type RequestBoundary,
  type RequestBoundaryOutcome,
} from '../requestBoundary';

/* v0.9.94: the request limit boundary of the workspace tools. A call that acts waits for it; a read never asks. */

const dirs: string[] = [];
const ownedTools: WorkspaceTools[] = []; const readers: OfficeReader[] = []; const stores: ContentAssetStore[] = [];
async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-tools-boundary-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const tools of ownedTools.splice(0)) tools.retire();
  await Promise.all(readers.splice(0).map(reader => reader.dispose())); await Promise.all(stores.splice(0).map(store => store.dispose()));
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  await removeTemporaryFolders();
});

const exists = (file: string) => fs.access(file).then(() => true, () => false);

/** A boundary the test answers by hand. */
function heldBoundary() {
  const asked: Array<{ kind: string; tool?: string; answer(outcome: RequestBoundaryOutcome): void }> = [];
  const boundary: RequestBoundary = (kind, detail) => new Promise((resolve) => {
    asked.push({ kind, tool: detail?.tool, answer: resolve });
  });
  return { boundary, asked };
}

async function seen<T>(promise: Promise<T>): Promise<T | 'held'> {
  return Promise.race([promise, new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), 0))]);
}

interface Fixture {
  tools: WorkspaceTools;
  root: string;
  /** What the effects did, in the order they happened. */
  effects: string[];
  received: Message[];
  officeSnapshot?: string;
  workbookSnapshot?: string;
}

async function fixture(options: { trusted?: boolean; office?: boolean; presentation?: boolean; pdf?: boolean; workbook?: boolean } = {}): Promise<Fixture> {
  const root = await workspace();
  await fs.writeFile(path.join(root, 'notes.txt'), 'alpha\nbeta\n', 'utf8');
  await fs.writeFile(path.join(root, 'doomed.txt'), 'bye', 'utf8');
  await fs.mkdir(path.join(root, 'scratch'));
  await fs.writeFile(path.join(root, 'scratch', 'junk.txt'), 'junk', 'utf8');
  const effects: string[] = [];
  const received: Message[] = [];
  const bus = new MessageBus();
  bus.onAddressed('bob', (message) => { received.push(message); });
  // v0.9.97: a file the user attached, given to this agent for the turn: content-1.
  const assets = new ContentAssetStore();
  stores.push(assets);
  await assets.storeImage(PNG, 'user-attachment', 'image/png');
  const tools = new WorkspaceTools(
    root,
    new Set(['read', 'write', 'execute', 'message']),
    'alice',
    undefined,
    new CommandPolicy('all'),
    undefined,
    undefined,
    bus,
    undefined,
    asProvider(async (command) => { effects.push(`command:${command}`); return { code: 0, output: 'ran' }; }),
    undefined,
    undefined,
    undefined,
    async (_agentId, note) => { effects.push(`memory:${note}`); return 'Noted.'; },
    undefined,
    undefined,
    undefined,
    () => options.trusted ?? true,
    undefined,
    undefined,
    {
      // The first thing a fetch does is read this policy: it is the fetch's own first step.
      policy: () => { effects.push('web-policy'); return 'off'; },
      requestApproval: async () => ({ allow: false }),
    },
    undefined,
    assets,
  );
  tools.setDelegationContentSources([{ assetId: 'content-1', kind: 'user-attachment', label: 'logo.png', location: 'user image attachment', mediaKind: 'image' }]);
  tools.setWebSearch({ turnId: () => 'search-turn', host: new UnodeSearchHost({
    connection: () => ({ connectionId: 'unode', revision: 1, endpointBase: 'https://gateway.example/v1', secretName: 'search-key' }),
    secret: async () => 'fixture',
    policy: () => 'allow', approve: async () => ({ allow: true }),
    egress: async () => true, egressCurrent: () => true, activity: () => {},
    fetch: async () => {
      effects.push('paid-search');
      return new Response(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
    },
  }) });
  tools.setDocumentRenderer({ render: async request => {
    const yazl = require('yazl') as { ZipFile: new () => DocumentZip };
    return renderDocx(request, () => new yazl.ZipFile());
  } });
  ownedTools.push(tools);
  if (options.presentation) tools.setPresentationRenderer(await presentationRouteRenderer());
  if (options.pdf) { tools.setPdfEditor(await pdfRouteEditor()); await fs.writeFile(path.join(root, 'source.pdf'), await makePdf([{ text: 'Held PDF' }])); }
  let workbookSnapshot: string | undefined;
  if (options.workbook) {
    const reader = await workbookRouteReader(); tools.setWorkbookReader(reader, true); tools.setWorkbookEditor(await workbookRouteEditor()); tools.beginTurn();
    await fs.writeFile(path.join(root, 'book.xlsx'), await workbookFixture()); const read = await tools.run('read_workbook', { path: 'book.xlsx' });
    expect(read.status, read.output).toBe('success'); workbookSnapshot = JSON.parse(read.output).snapshot_ref;
  }
  let officeSnapshot: string | undefined;
  if (options.office) {
    const reader = await officeRouteReader(); readers.push(reader); tools.setOfficeReader(reader); tools.setOfficeEditor(await officeRouteEditor()); tools.beginTurn();
    await fs.writeFile(path.join(root, 'source.docx'), await officeRouteDocument()); const read = await tools.run('inspect_office', { path: 'source.docx' });
    expect(read.status, read.output).toBe('success'); officeSnapshot = JSON.parse(read.output).snapshot_ref;
  }
  return { tools, root, effects, received, officeSnapshot, workbookSnapshot };
}

/** Every governed workspace tool, with a call that would act and a way to see whether it did. */
const GOVERNED_CALLS: Array<{ tool: string; args: Record<string, unknown> | ((fixture: Fixture) => Record<string, unknown>); acted(fixture: Fixture): Promise<boolean> }> = [
  { tool: 'write_file', args: { path: 'new.txt', content: 'written' }, acted: ({ root }) => exists(path.join(root, 'new.txt')) },
  {
    tool: 'apply_edit', args: { path: 'notes.txt', old_string: 'alpha', new_string: 'omega' },
    acted: async ({ root }) => (await fs.readFile(path.join(root, 'notes.txt'), 'utf8')).includes('omega'),
  },
  {
    tool: 'apply_patch',
    args: { patch: '*** Begin Patch\n*** Update File: notes.txt\n@@\n-alpha\n+omega\n*** End Patch' },
    acted: async ({ root }) => (await fs.readFile(path.join(root, 'notes.txt'), 'utf8')).includes('omega'),
  },
  { tool: 'delete_file', args: { path: 'doomed.txt' }, acted: async ({ root }) => !(await exists(path.join(root, 'doomed.txt'))) },
  { tool: 'delete_dir', args: { path: 'scratch' }, acted: async ({ root }) => !(await exists(path.join(root, 'scratch'))) },
  { tool: 'run_command', args: { command: 'npm test' }, acted: async ({ effects }) => effects.some((effect) => effect.startsWith('command:')) },
  { tool: 'fetch_url', args: { url: 'https://example.com/' }, acted: async ({ effects }) => effects.includes('web-policy') },
  { tool: 'web_search', args: { query: 'public news' }, acted: async ({ effects }) => effects.includes('paid-search') },
  { tool: 'send_message', args: { target: 'bob', message: 'ship it' }, acted: async ({ received }) => received.length > 0 },
  { tool: 'memory_note', args: { note: 'remember this', kind: 'decision' }, acted: async ({ effects }) => effects.includes('memory:remember this') },
  // v0.9.97: saving a user's attachment writes a file.
  { tool: 'save_attachment', args: { asset_id: 'content-1', path: 'saved.png' }, acted: ({ root }) => exists(path.join(root, 'saved.png')) },
  { tool: 'write_document', args: { schema_version: 1, path: 'generated.docx', format: 'docx', template: 'report-v1',
    document: { title: 'Generated', blocks: [{ type: 'paragraph', content: [{ text: 'body' }] }] } },
  acted: ({ root }) => exists(path.join(root, 'generated.docx')) },
  { tool: 'write_presentation', args: presentationInput('generated.pptx'), acted: ({ root }) => exists(path.join(root, 'generated.pptx')) },
  { tool: 'edit_office', args: context => ({ schema_version: 1, path: 'edited.docx', snapshot_ref: context.officeSnapshot,
    edits: [{ op: 'replace_text', target_ref: 'D1', find: 'Actual Office 名称', replace: 'Edited' }] }), acted: ({ root }) => exists(path.join(root, 'edited.docx')) },
  // v0.9.108: a PDF edit writes a file.
  { tool: 'edit_pdf', args: { schema_version: 1, destination: 'edited.pdf', inputs: [{ path: 'source.pdf' }], operations: [{ op: 'rotate_pages', pages: '1', degrees: 90 }] },
    acted: ({ root }) => exists(path.join(root, 'edited.pdf')) },
  // v0.9.108: both workbook writers write a file.
  { tool: 'write_workbook', args: { schema_version: 1, path: 'generated.xlsx', sheets: [{ name: 'A', rows: [[1]] }] }, acted: ({ root }) => exists(path.join(root, 'generated.xlsx')) },
  { tool: 'edit_workbook', args: context => ({ schema_version: 1, path: 'edited.xlsx', snapshot_ref: context.workbookSnapshot,
    edits: [{ op: 'set_cells', sheet_id: 'sheet-1', range: 'J1', values: [[1]] }] }), acted: ({ root }) => exists(path.join(root, 'edited.xlsx')) },
];

/** Workspace tools a request at its limit may still call: they read, list, search or keep the agent's own bookkeeping. */
const NEVER_HELD = [
  'read_file', 'read_workbook', 'transform_workbook', 'inspect_office', 'list_dir', 'search_files', 'inspect_git_tag', 'check_command', 'kill_command',
  'send_image_asset_to_model', 'read_extracted_content', 'search_extracted_content',
  'search_conversation_log', 'read_conversation_log', 'report_context_gap', 'publish_task_artifact',
  'select_workflow_branch', 'update_todos',
  'view_office_images', 'inspect_operation', 'stop_operation',
];

describe('WorkspaceTools request boundary', () => {
  it('classifies every workspace tool as held or never held', async () => {
    // Complete managed/image/render effect flows live in their affected real-entry suites.
    expect([...GOVERNED_CALLS.map((call) => call.tool), 'build_office', 'generate_image', 'save_generated_asset', 'transcribe_audio', 'render_office', 'export_pdf', 'convert_pdf_to_docx', 'view_pdf_pages', 'recalculate_workbook'].sort()).toEqual([...GOVERNED_WORKSPACE_TOOLS].sort());
    const { tools } = await fixture();
    const advertised = new Set(tools.specs().map((spec) => spec.function.name));
    expect(advertised.has('web_search')).toBe(true);
    tools.setEditToolDialect('apply-patch');
    for (const spec of tools.specs()) advertised.add(spec.function.name);
    // A tool nobody classified fails here, so a new tool that acts cannot slip past the boundary unnoticed.
    expect([...advertised].filter((name) => !isGovernedWorkspaceTool(name) && !NEVER_HELD.includes(name))).toEqual([]);
    for (const name of [...GOVERNED_WORKSPACE_TOOLS, ...NEVER_HELD]) expect(tools.canRoute(name), name).toBe(true);
    expect(NEVER_HELD.filter((name) => isGovernedWorkspaceTool(name))).toEqual([]);
  });

  for (const call of GOVERNED_CALLS) {
    it(`holds ${call.tool} until the answer and runs it after Continue`, async () => {
      const context = await fixture({ office: call.tool === 'edit_office', presentation: call.tool === 'write_presentation', pdf: call.tool === 'edit_pdf', workbook: call.tool.endsWith('_workbook') });
      const { boundary, asked } = heldBoundary();
      context.tools.setRequestBoundary(boundary);
      const running = context.tools.run(call.tool, typeof call.args === 'function' ? call.args(context) : call.args);
      expect(await seen(running)).toBe('held');
      expect(asked.map(({ kind, tool }) => ({ kind, tool }))).toEqual([{ kind: 'effect', tool: call.tool }]);
      expect(await call.acted(context)).toBe(false);

      asked[0].answer('proceed');
      if (call.tool === 'web_search') {
        await vi.waitFor(() => expect(asked[1]).toMatchObject({ kind: 'provider-request', tool: 'web_search' }));
        expect(await call.acted(context)).toBe(false);
        asked[1].answer('proceed');
      }
      const result = await running;
      expect(result.status === 'refused' ? result.reason : undefined).not.toBe('safety-limit');
      expect(await call.acted(context)).toBe(true);
      expect(asked).toHaveLength(call.tool === 'web_search' ? 2 : 1);
    });

    it(`refuses ${call.tool} with safety-limit after Stop, and it does not act`, async () => {
      const context = await fixture({ office: call.tool === 'edit_office', presentation: call.tool === 'write_presentation', pdf: call.tool === 'edit_pdf', workbook: call.tool.endsWith('_workbook') });
      const { boundary, asked } = heldBoundary();
      context.tools.setRequestBoundary(boundary);
      const running = context.tools.run(call.tool, typeof call.args === 'function' ? call.args(context) : call.args);
      expect(await seen(running)).toBe('held');
      asked[0].answer('stopped');
      const result = await running;
      expect(result).toMatchObject({ status: 'refused', reason: 'safety-limit', source: 'host' });
      expect(result.output).toBe(
        `${call.tool === 'fetch_url' ? 'Web access denied' : `${call.tool} refused`}: safety-limit. ${REQUEST_LIMIT_STOPPED_REFUSAL}`,
      );
      expect(await call.acted(context)).toBe(false);
      expect(context.tools.takeLastRunResult()).toMatchObject({ status: 'refused', reason: 'safety-limit' });
    });
  }

  it('never asks for a read, a listing, a search or the agent\'s own bookkeeping', async () => {
    const context = await fixture();
    const asked: string[] = [];
    context.tools.setRequestBoundary(async (_kind, detail) => { asked.push(detail?.tool ?? ''); return 'stopped'; });
    expect((await context.tools.run('read_file', { path: 'notes.txt' })).output).toContain('alpha');
    expect((await context.tools.run('list_dir', { path: '.' })).output).toContain('notes.txt');
    expect((await context.tools.run('search_files', { query: 'beta' })).output).toContain('notes.txt');
    expect((await context.tools.run('update_todos', { todos: [{ content: 'step', status: 'pending' }] })).status).toBe('success');
    for (const [name, args] of [
      ['check_command', { id: 'bg-1' }],
      ['kill_command', { id: 'bg-1' }],
      ['read_extracted_content', { assetId: 'content-1' }],
      ['search_extracted_content', { assetId: 'content-1', query: 'x' }],
      ['search_conversation_log', { query: 'x' }],
      ['read_conversation_log', { entries: { start: 1, end: 2 } }],
      ['select_workflow_branch', { label: 'x' }],
      ['report_context_gap', { inputId: 'x' }],
      ['publish_task_artifact', { content: 'x' }],
      ['inspect_git_tag', { repository_path: context.root, tag: 'v0' }],
    ] as const) {
      const result = await context.tools.run(name, args);
      expect(result.status === 'refused' ? result.reason : undefined, name).not.toBe('safety-limit');
    }
    expect(asked).toEqual([]);
  });

  it('refuses a call for a cheaper reason first, without asking anyone about the limit', async () => {
    const untrusted = await fixture({ trusted: false });
    const asked: string[] = [];
    untrusted.tools.setRequestBoundary(async (_kind, detail) => { asked.push(detail?.tool ?? ''); return 'proceed'; });
    await expect(untrusted.tools.run('write_file', { path: 'new.txt', content: 'x' })).resolves.toMatchObject({ status: 'refused', reason: 'trust' });
    const trusted = await fixture();
    trusted.tools.setRequestBoundary(async (_kind, detail) => { asked.push(detail?.tool ?? ''); return 'proceed'; });
    await expect(trusted.tools.run('write_file', { content: 'x' })).resolves.toMatchObject({ status: 'failed' });
    expect(asked).toEqual([]);
  });

  it('stops rather than acts when the boundary itself fails', async () => {
    const context = await fixture();
    context.tools.setRequestBoundary(async () => { throw new Error('host fault'); });
    await expect(context.tools.run('write_file', { path: 'new.txt', content: 'x' }))
      .resolves.toMatchObject({ status: 'refused', reason: 'safety-limit' });
    expect(await exists(path.join(context.root, 'new.txt'))).toBe(false);
  });

  it('changes nothing without a boundary, and after the boundary is removed', async () => {
    const context = await fixture();
    await expect(context.tools.run('write_file', { path: 'one.txt', content: '1' })).resolves.toMatchObject({ status: 'success' });
    context.tools.setRequestBoundary(async () => 'stopped');
    await expect(context.tools.run('write_file', { path: 'two.txt', content: '2' })).resolves.toMatchObject({ status: 'refused' });
    context.tools.setRequestBoundary(undefined);
    await expect(context.tools.run('write_file', { path: 'two.txt', content: '2' })).resolves.toMatchObject({ status: 'success' });
    expect(await exists(path.join(context.root, 'two.txt'))).toBe(true);
  });
});
