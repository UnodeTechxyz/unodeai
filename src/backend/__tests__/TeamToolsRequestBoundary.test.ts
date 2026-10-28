import { beforeEach, describe, expect, it } from 'vitest';
import { TeamTools, type TeamToolsOptions, type TeamView } from '../TeamTools';
import { directPreparer } from './shellFixtures';
import { MessageBus } from '../../bus/MessageBus';
import type { Message } from '../../types';
import { CommandPolicy } from '../CommandPolicy';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { TaskInputResolver } from '../TaskContract';
import { summarizeToolResult } from '../toolSummary';
import {
  GOVERNED_TEAM_TOOLS,
  isClassifiedTeamTool,
  isGovernedTeamTool,
  REQUEST_LIMIT_STOPPED_REFUSAL,
  UNHELD_TEAM_TOOLS,
  type RequestBoundary,
  type RequestBoundaryOutcome,
} from '../requestBoundary';

/* v0.9.94: the request limit boundary of the team tools. A dispatch, a broadcast and a check run wait for it;
   reading results, closing the assignment and stopping a teammate never ask. */

const roster = [
  { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
  {
    id: 'dev', role: 'senior-dev', name: 'Dev', status: 'idle',
    capabilities: { read: true, write: true, shell: true, verificationSensors: ['command-exit-zero', 'run-checks'], toolFamilies: ['read', 'write', 'execute'], backend: 'openai-compat', taskScope: 'per-turn' as const },
  },
];

const view: TeamView = {
  list: () => roster,
  preflightTaskScope: () => undefined,
  resolve: (ref) => (ref === 'dev' || ref === 'senior-dev' ? { id: 'dev' } : ref === 'pm' ? { id: 'pm' } : undefined),
};

function taskContract(): Record<string, unknown> {
  return {
    version: 1,
    objective: 'Complete the declared task.',
    expected_deliverable: 'Return the concrete result.',
    effects: { read_files: [], expected_file_effect: 'none' },
    inputs: [],
    constraints: [],
    dependencies: [],
    required_capabilities: { version: 1, capabilities: [] },
    execution_strategy: 'delegate-required',
  };
}

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

describe('TeamTools request boundary', () => {
  let bus: MessageBus;
  let sent: Message[];
  let checksRun: number;

  beforeEach(() => {
    bus = new MessageBus();
    sent = [];
    checksRun = 0;
    bus.onType('task.assign', (message) => { sent.push(message); });
    bus.onType('broadcast.info', (message) => { sent.push(message); });
  });

  function team(options: TeamToolsOptions = {}): TeamTools {
    return new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      cwd: process.cwd(),
      taskInputResolver: new TaskInputResolver(new ContentAssetStore(), process.cwd()),
      verifyCommand: 'npm test',
      commandPolicy: new CommandPolicy('all'),
      prepareCommand: directPreparer(async () => { checksRun += 1; return { code: 0, output: 'ok' }; }),
      ...options,
    });
  }

  it('classifies every team tool as held or never held', () => {
    const tools = team();
    const names = [...tools.specs().map((spec) => spec.function.name), 'assign_task', 'assign_task_async', 'await_tasks'];
    // A team tool nobody classified fails here, so a new tool that dispatches cannot slip past the boundary unnoticed.
    expect(names.filter((name) => !isClassifiedTeamTool(name))).toEqual([]);
    for (const name of [...GOVERNED_TEAM_TOOLS, ...UNHELD_TEAM_TOOLS]) expect(tools.has(name), name).toBe(true);
    expect(GOVERNED_TEAM_TOOLS.filter((name) => (UNHELD_TEAM_TOOLS as readonly string[]).includes(name))).toEqual([]);
    for (const name of GOVERNED_TEAM_TOOLS) expect(isGovernedTeamTool(name, {}), name).toBe(true);
    for (const name of UNHELD_TEAM_TOOLS) expect(isGovernedTeamTool(name, {}), name).toBe(false);
    // Recording a decision is held only when the decision sends the teammate a message.
    expect(isGovernedTeamTool('record_task_disposition', { disposition: 'needs-rework' })).toBe(true);
    expect(isGovernedTeamTool('record_task_disposition', { disposition: 'rejected' })).toBe(true);
    expect(isGovernedTeamTool('record_task_disposition', { disposition: 'accepted' })).toBe(false);
    expect(isGovernedTeamTool('record_task_disposition', { disposition: 'needs-human' })).toBe(false);
  });

  it('holds a dispatch until the answer and sends it after Continue', async () => {
    const { boundary, asked } = heldBoundary();
    const tools = team({ requestBoundary: boundary });
    const running = tools.runOutcome('dispatch_task', { agent: 'dev', instruction: 'Take it.', contract: taskContract() });
    expect(await seen(running)).toBe('held');
    expect(asked.map(({ kind, tool }) => ({ kind, tool }))).toEqual([{ kind: 'effect', tool: 'dispatch_task' }]);
    expect(sent).toEqual([]);

    asked[0].answer('proceed');
    await expect(running).resolves.toMatchObject({ status: 'success' });
    expect(sent.map((message) => message.type)).toEqual(['task.assign']);
    expect(asked).toHaveLength(1);
  });

  it('refuses a held dispatch with safety-limit after Stop, and nothing is sent', async () => {
    const { boundary, asked } = heldBoundary();
    const tools = team({ requestBoundary: boundary });
    tools.beginTurnContentReceipts();
    const running = tools.runOutcome('dispatch_task', { agent: 'dev', instruction: 'Take it.', contract: taskContract() });
    expect(await seen(running)).toBe('held');
    asked[0].answer('stopped');
    const outcome = await running;
    expect(outcome).toEqual({ source: 'host', contentSource: 'host', status: 'refused', reason: 'safety-limit', output: REQUEST_LIMIT_STOPPED_REFUSAL });
    expect(summarizeToolResult('dispatch_task', {}, outcome).fact).toEqual({ status: 'refused', observedBy: 'host', reason: 'safety-limit' });
    expect(sent).toEqual([]);
    // The text adapter says the same sentence and sends nothing either.
    const text = tools.run('assign_task_async', { agent: 'dev', instruction: 'Take this too.' });
    expect(await seen(text)).toBe('held');
    asked[1].answer('stopped');
    expect(await text).toBe(REQUEST_LIMIT_STOPPED_REFUSAL);
    expect(sent).toEqual([]);
  });

  it('holds a broadcast and a check run, and runs neither when the person stops the request', async () => {
    const { boundary, asked } = heldBoundary();
    const tools = team({ requestBoundary: boundary });
    const broadcast = tools.runOutcome('broadcast', { message: 'standup at 3' });
    const checks = tools.runOutcome('run_checks', {});
    expect(await seen(broadcast)).toBe('held');
    expect(await seen(checks)).toBe('held');
    expect(asked.map(({ tool }) => tool)).toEqual(['broadcast', 'run_checks']);
    expect(sent).toEqual([]);
    expect(checksRun).toBe(0);

    asked[0].answer('proceed');
    asked[1].answer('stopped');
    await expect(broadcast).resolves.toMatchObject({ status: 'success' });
    await expect(checks).resolves.toMatchObject({ status: 'refused', reason: 'safety-limit' });
    expect(sent.map((message) => message.type)).toEqual(['broadcast.info']);
    expect(checksRun).toBe(0);

    const allowed = tools.runOutcome('run_checks', {});
    expect(await seen(allowed)).toBe('held');
    asked[2].answer('proceed');
    await expect(allowed).resolves.toMatchObject({ status: 'success' });
    expect(checksRun).toBe(1);
  });

  it('asks before the calls that dispatch or message, and before no other', async () => {
    const asked: string[] = [];
    const tools = team({ requestBoundary: async (_kind, detail) => { asked.push(detail?.tool ?? ''); return 'stopped'; } });
    for (const [name, args] of [
      ['dispatch_task', { agent: 'dev', instruction: 'x', contract: taskContract() }],
      ['assign_task', { agent: 'dev', instruction: 'x' }],
      ['assign_task_async', { agent: 'dev', instruction: 'x' }],
      ['continue_task', { handle: 'h-1' }],
      ['broadcast', { message: 'x' }],
      ['run_checks', {}],
      ['record_task_disposition', { handle: 'h-1', disposition: 'needs-rework', reason: 'r' }],
      ['record_task_disposition', { handle: 'h-1', disposition: 'rejected', reason: 'r' }],
    ] as const) {
      await expect(tools.runOutcome(name, args), name).resolves.toMatchObject({ status: 'refused', reason: 'safety-limit' });
    }
    expect(asked).toEqual([
      'dispatch_task', 'assign_task', 'assign_task_async', 'continue_task', 'broadcast', 'run_checks',
      'record_task_disposition', 'record_task_disposition',
    ]);

    asked.length = 0;
    for (const [name, args] of [
      ['list_agents', {}],
      ['collect_ready_tasks', {}],
      ['inspect_task_status', {}],
      ['delegation_metrics', {}],
      ['cancel_task', { all: true }],
      ['close_assignment', { outcome: 'blocked', summary: 'Stopped at the request limit.', incomplete: [{ item: 'the rest', reason: 'the request was stopped' }] }],
      ['record_task_disposition', { handle: 'h-1', disposition: 'accepted' }],
      ['publish_content_receipt', { receipt_id: 'missing', state: 'shown' }],
    ] as const) {
      const outcome = await tools.runOutcome(name, args);
      expect(outcome.status === 'refused' ? outcome.reason : undefined, name).not.toBe('safety-limit');
    }
    expect(asked).toEqual([]);
    expect(sent).toEqual([]);
    expect(checksRun).toBe(0);
  });

  it('refuses a worker\'s dispatch as before, without asking about the limit', async () => {
    const asked: string[] = [];
    const worker = new TeamTools('dev', view, bus, {
      coordinatorId: 'pm',
      requestBoundary: async (_kind, detail) => { asked.push(detail?.tool ?? ''); return 'proceed'; },
    });
    await expect(worker.runOutcome('dispatch_task', { agent: 'dev', instruction: 'x', contract: taskContract() }))
      .resolves.toMatchObject({ status: 'refused', reason: 'capability' });
    expect(asked).toEqual([]);
  });

  it('notes the arrival of a held first action before it waits, so a deadline cannot expire on a held call', async () => {
    const order: string[] = [];
    const { boundary, asked } = heldBoundary();
    const tools = team({
      requestBoundary: (kind, detail) => { order.push('boundary'); return boundary(kind, detail); },
      firstAction: {
        arrived: (tool) => { order.push(`arrived:${tool}`); return true; },
        answered: (tool, accepted) => { order.push(`answered:${tool}:${accepted}`); },
      },
    });
    const running = tools.runOutcome('dispatch_task', { agent: 'dev', instruction: 'Take it.', contract: taskContract() });
    expect(await seen(running)).toBe('held');
    expect(order).toEqual(['arrived:dispatch_task', 'boundary']);
    asked[0].answer('stopped');
    await running;
    expect(order).toEqual(['arrived:dispatch_task', 'boundary', 'answered:dispatch_task:false']);
  });

  it('takes a boundary set after construction, and none after it is removed', async () => {
    const tools = team();
    await expect(tools.runOutcome('broadcast', { message: 'one' })).resolves.toMatchObject({ status: 'success' });
    tools.setRequestBoundary(async () => 'stopped');
    await expect(tools.runOutcome('broadcast', { message: 'two' })).resolves.toMatchObject({ status: 'refused', reason: 'safety-limit' });
    tools.setRequestBoundary(undefined);
    await expect(tools.runOutcome('broadcast', { message: 'three' })).resolves.toMatchObject({ status: 'success' });
    expect(sent.map((message) => message.payload.instruction)).toEqual(['one', 'three']);
  });
});
