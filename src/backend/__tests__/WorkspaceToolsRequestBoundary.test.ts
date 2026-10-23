import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceTools } from '../WorkspaceTools';
import { asProvider } from './shellFixtures';
import { CommandPolicy } from '../CommandPolicy';
import { MessageBus } from '../../bus/MessageBus';
import type { Message } from '../../types';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { PNG } from './attachmentSaveFixtures';
import {
  GOVERNED_WORKSPACE_TOOLS,
  isGovernedWorkspaceTool,
  REQUEST_LIMIT_STOPPED_REFUSAL,
  type RequestBoundary,
  type RequestBoundaryOutcome,
} from '../requestBoundary';

/* v0.9.94: the request limit boundary of the workspace tools. A call that acts waits for it; a read never asks. */

const dirs: string[] = [];
async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-tools-boundary-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
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
}

async function fixture(options: { trusted?: boolean } = {}): Promise<Fixture> {
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
  return { tools, root, effects, received };
}

/** Every governed workspace tool, with a call that would act and a way to see whether it did. */
const GOVERNED_CALLS: Array<{ tool: string; args: Record<string, unknown>; acted(fixture: Fixture): Promise<boolean> }> = [
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
  { tool: 'send_message', args: { target: 'bob', message: 'ship it' }, acted: async ({ received }) => received.length > 0 },
  { tool: 'memory_note', args: { note: 'remember this', kind: 'decision' }, acted: async ({ effects }) => effects.includes('memory:remember this') },
  // v0.9.97: saving a user's attachment writes a file.
  { tool: 'save_attachment', args: { asset_id: 'content-1', path: 'saved.png' }, acted: ({ root }) => exists(path.join(root, 'saved.png')) },
];

/** Workspace tools a request at its limit may still call: they read, list, search or keep the agent's own bookkeeping. */
const NEVER_HELD = [
  'read_file', 'list_dir', 'search_files', 'inspect_git_tag', 'check_command', 'kill_command',
  'send_image_asset_to_model', 'read_extracted_content', 'search_extracted_content',
  'search_conversation_log', 'read_conversation_log', 'report_context_gap', 'publish_task_artifact',
  'select_workflow_branch', 'update_todos',
];

describe('WorkspaceTools request boundary', () => {
  it('classifies every workspace tool as held or never held', async () => {
    expect(GOVERNED_CALLS.map((call) => call.tool).sort()).toEqual([...GOVERNED_WORKSPACE_TOOLS].sort());
    const { tools } = await fixture();
    const advertised = new Set(tools.specs().map((spec) => spec.function.name));
    tools.setEditToolDialect('apply-patch');
    for (const spec of tools.specs()) advertised.add(spec.function.name);
    // A tool nobody classified fails here, so a new tool that acts cannot slip past the boundary unnoticed.
    expect([...advertised].filter((name) => !isGovernedWorkspaceTool(name) && !NEVER_HELD.includes(name))).toEqual([]);
    for (const name of [...GOVERNED_WORKSPACE_TOOLS, ...NEVER_HELD]) expect(tools.canRoute(name), name).toBe(true);
    expect(NEVER_HELD.filter((name) => isGovernedWorkspaceTool(name))).toEqual([]);
  });

  for (const call of GOVERNED_CALLS) {
    it(`holds ${call.tool} until the answer and runs it after Continue`, async () => {
      const context = await fixture();
      const { boundary, asked } = heldBoundary();
      context.tools.setRequestBoundary(boundary);
      const running = context.tools.run(call.tool, call.args);
      expect(await seen(running)).toBe('held');
      expect(asked.map(({ kind, tool }) => ({ kind, tool }))).toEqual([{ kind: 'effect', tool: call.tool }]);
      expect(await call.acted(context)).toBe(false);

      asked[0].answer('proceed');
      const result = await running;
      expect(result.status === 'refused' ? result.reason : undefined).not.toBe('safety-limit');
      expect(await call.acted(context)).toBe(true);
      expect(asked).toHaveLength(1);
    });

    it(`refuses ${call.tool} with safety-limit after Stop, and it does not act`, async () => {
      const context = await fixture();
      const { boundary, asked } = heldBoundary();
      context.tools.setRequestBoundary(boundary);
      const running = context.tools.run(call.tool, call.args);
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
