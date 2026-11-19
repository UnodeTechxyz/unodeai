import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ids = vi.hoisted(() => ({ queue: [] as string[], next: 0 }));
vi.mock('uuid', () => ({ v4: () => ids.queue.shift() ?? `issued-${++ids.next}` }));

import { TeamTools, type TeamView } from '../TeamTools';
import { MessageBus } from '../../bus/MessageBus';
import { Message } from '../../types';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { TaskInputResolver } from '../TaskContract';
import {
  F8_EXECUTOR, F8_EXISTING_TARGETS, F8_HANDLE, F8_LATER_TARGETS, F8_LATER_TASK, F8_REWORK_REASON,
} from './similarTaskFixtures';

// v0.9.99 P3, condition C2: the F8 pair is driven through the real dispatch admission, with handle 12e2f409 in the
// state the field record shows at the later task's admission: the same run, on the same Contract Analyst, revision 1
// returned and its needs-rework continuation still running. The record keeps the rework reason and the later task
// verbatim, not the original T1/T2 instruction; this one stands in for it.
const ANALYST = F8_EXECUTOR;
const F8_ORIGINAL = 'T1/T2: apply the revised wording to the Traditional Chinese v2.0 text and Word, and keep both in step.';

const roster = [
  { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
  {
    id: ANALYST, role: 'custom', name: 'Contract Analyst', status: 'idle',
    capabilities: { read: true, write: true, shell: false, toolFamilies: ['read', 'write'], taskScope: 'per-turn' as const },
  },
  {
    id: 'translator', role: 'custom', name: 'Translator', status: 'idle',
    capabilities: { read: true, write: true, shell: false, toolFamilies: ['read', 'write'], taskScope: 'per-turn' as const },
  },
];
const view: TeamView = {
  list: () => roster,
  preflightTaskScope: () => undefined,
  resolve: (ref) => roster.find((entry) => entry.id === ref) ? { id: ref } : undefined,
};

/** Each contract declares its own paths; the records declare the same ones as inputs and read_files, none as scope. */
const contract = (paths: readonly string[] = F8_LATER_TARGETS, fields: Record<string, unknown> = {}) => ({
  version: 1,
  objective: 'Edit the Traditional Chinese contract text and Word.',
  expected_deliverable: 'The corrected files.',
  effects: { read_files: [...paths], expected_file_effect: 'modify' },
  inputs: [],
  constraints: [],
  dependencies: [],
  required_capabilities: { version: 1, capabilities: ['read', 'write'] },
  execution_strategy: 'delegate-required',
  ...fields,
});

const handleOf = (text: string) => /Handle: ([^\s.]+)/.exec(text)?.[1] ?? '';
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => queueMicrotask(resolve)); };

describe('similar-task notice at dispatch admission (v0.9.99 P3)', () => {
  let root: string;
  let bus: MessageBus;
  let team: TeamTools;
  let routes: string[];

  beforeEach(() => {
    ids.queue = [];
    root = mkdtempSync(join(tmpdir(), 'similar-task-'));
    mkdirSync(join(root, 'contracts', 'v2.0'), { recursive: true });
    for (const path of new Set([...F8_EXISTING_TARGETS, ...F8_LATER_TARGETS])) writeFileSync(join(root, path), 'content');
    bus = new MessageBus();
    routes = [];
    team = new TeamTools('pm', view, bus, {
      timeoutMs: 60_000,
      cwd: root,
      evidenceEnabled: true,
      taskInputResolver: new TaskInputResolver(new ContentAssetStore(), root),
      onRoute: (line) => routes.push(line),
      onAsyncResultReady: () => true,
    });
    team.beginTurnContentReceipts();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Dispatch the original T1/T2 task as handle 12e2f409, let it return, and send it back with the F8 reason. */
  async function f8HandleInRework(): Promise<void> {
    bus.onType('task.assign', (message: Message) => {
      if (message.correlationId !== F8_HANDLE) return;
      bus.send(ANALYST, 'pm', 'task.complete', {
        instruction: 'T1/T2 saved.',
        metadata: { delegationEvidence: { hadToolActions: true, changedFiles: ['contracts/v2.0/ZH-Hant.txt'] } },
      }, 'normal', message.correlationId);
    });
    ids.queue = ['contract-original', F8_HANDLE];
    const first = await team.run('dispatch_task', { agent: ANALYST, instruction: F8_ORIGINAL, contract: contract(F8_EXISTING_TARGETS) });
    expect(handleOf(first)).toBe(F8_HANDLE);
    await flush();
    expect(team.consumeAsyncResult(F8_HANDLE)).toBe(true);
    team.beginTurnContentReceipts();
    expect(await team.run('record_task_disposition', { handle: F8_HANDLE, disposition: 'needs-rework', reason: F8_REWORK_REASON }))
      .toContain(`sent to ${ANALYST}`);
  }

  it('notices the F8 later task against the live 12e2f409 through the real admission point', async () => {
    await f8HandleInRework();
    const later = await team.run('dispatch_task', { agent: ANALYST, instruction: F8_LATER_TASK, contract: contract() });
    const laterHandle = handleOf(later);
    expect(laterHandle).not.toBe('');
    expect(later).toContain(`Similar task ${F8_HANDLE} to ${ANALYST} is running. This new task ${laterHandle} was dispatched. `
      + `If it repeats ${F8_HANDLE}, use cancel_task with handle ${laterHandle}.`);
    // The notice adds a line; the dispatch itself went ahead.
    expect(later).toContain(`Handle: ${laterHandle}`);
    expect(routes).toContain(`Similar-task notice: ${laterHandle} resembles ${F8_HANDLE} (signature)`);
    // Nothing of either instruction is written to the route log.
    expect(routes.join('\n')).not.toContain('不得無故延遲通知');
  });

  it('compares the latest rework reason, not only the original instruction', async () => {
    await f8HandleInRework();
    // Against the original T1/T2 instruction alone the later task is not similar.
    const original = await team.run('dispatch_task', { agent: 'translator', instruction: F8_ORIGINAL, contract: contract() });
    expect(original).not.toContain('Similar task');
    const later = await team.run('dispatch_task', { agent: ANALYST, instruction: F8_LATER_TASK, contract: contract() });
    expect(later).toContain(`Similar task ${F8_HANDLE}`);
  });

  it('says "returned" for a task settled within the window, and nothing once it is two turns older', async () => {
    await f8HandleInRework();
    bus.send(ANALYST, 'pm', 'task.complete', { instruction: 'Rework saved.' }, 'normal', F8_HANDLE);
    await flush();
    expect(team.consumeAsyncResult(F8_HANDLE)).toBe(true);
    team.beginTurnContentReceipts();
    team.beginTurnContentReceipts();
    const inside = await team.run('dispatch_task', { agent: ANALYST, instruction: F8_LATER_TASK, contract: contract() });
    expect(inside).toContain(`Similar task ${F8_HANDLE} to ${ANALYST} is returned.`);
    await team.run('cancel_task', { handle: handleOf(inside) });

    team.beginTurnContentReceipts();
    const outside = await team.run('dispatch_task', { agent: ANALYST, instruction: F8_LATER_TASK, contract: contract() });
    expect(outside).toContain('Handle: ');
    expect(outside).not.toContain('Similar task');
  });

  it('gives no notice for another executor, and none for a refused dispatch', async () => {
    await f8HandleInRework();
    const elsewhere = await team.run('dispatch_task', { agent: 'translator', instruction: F8_LATER_TASK, contract: contract() });
    expect(elsewhere).not.toContain('Similar task');

    const refused = await team.run('dispatch_task', { agent: 'nobody', instruction: 'Draft the release note.', contract: contract() });
    expect(refused).not.toContain('Handle:');
    const after = await team.run('dispatch_task', { agent: 'translator', instruction: 'Draft the release note.', contract: contract() });
    expect(after).not.toContain('Similar task');
  });

  it('gives no notice to a replacement, which already names its relation', async () => {
    const replacing = new TeamTools('pm', view, bus, {
      timeoutMs: 60_000,
      cwd: root,
      taskInputResolver: new TaskInputResolver(new ContentAssetStore(), root),
      inspectTaskStatus: (handles) => handles.map((handle) => ({ handle, lifecycle: handle === 'lost-1' ? 'interrupted' as const : 'unknown' as const })),
    });
    replacing.beginTurnContentReceipts();
    const first = await replacing.run('dispatch_task', { agent: ANALYST, instruction: F8_LATER_TASK, contract: contract() });
    expect(handleOf(first)).not.toBe('');
    const replacement = await replacing.run('dispatch_task', {
      agent: ANALYST, instruction: F8_LATER_TASK, contract: contract(),
      replaces_handle: 'lost-1', replacement_reason: 'The worker was lost.',
    });
    expect(replacement).toContain('Interrupted handle lost-1 will be superseded');
    expect(replacement).not.toContain('Similar task');
    // Without the relation the same dispatch is noticed.
    const repeat = await replacing.run('dispatch_task', { agent: ANALYST, instruction: F8_LATER_TASK, contract: contract() });
    expect(repeat).toContain('Similar task');
  });

  it('notices an exact repeat through the legacy alias too', async () => {
    const first = await team.run('assign_task_async', { agent: 'translator', instruction: 'Draft the release note for v0.9.99.' });
    const second = await team.run('assign_task_async', { agent: 'translator', instruction: 'Draft the release note for v0.9.99.' });
    expect(second).toContain(`Similar task ${handleOf(first)} to translator is running.`);
  });
});
