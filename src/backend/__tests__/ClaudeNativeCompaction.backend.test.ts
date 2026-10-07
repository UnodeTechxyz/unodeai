import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { ClaudeHeadlessBackend } from '../ClaudeHeadlessBackend';
import type { AgentConfig } from '../../types';
import type { ResolvedSmartCompactionPolicy } from '../../compaction/SmartCompactionPolicy';

function makeConfig(): AgentConfig {
  return {
    id: 'claude-1', name: 'Claude Dev', role: 'developer', skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'claude-sonnet-4-5', systemPrompt: 'Follow the role.', autoApprove: true, allowedTools: [],
    backend: 'claude', workingDirectory: process.cwd(),
  };
}

function fakeSpawn() {
  const calls: Array<{ cmd: string; args: string[]; options?: Record<string, any> }> = [];
  const fn = (cmd: string, args: string[], options?: Record<string, any>) => {
    calls.push({ cmd, args, options });
    const proc = new EventEmitter() as any;
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
  return { fn, calls };
}

const policy: ResolvedSmartCompactionPolicy = {
  mode: 'smart', profile: 'balanced', resolutionSource: 'role-template', revision: 'abc123def456',
  windowPercent: 70, ceilingTokens: 250_000, recentTailTokens: 48_000, postCompactTargetTokens: 80_000,
  activeTriggerTokens: 250_000, winningTerm: 'practical-ceiling',
};

// Event shapes observed from Claude CLI 2.1.209 on 2026-09-28.
const status = (fields: Record<string, unknown>) => ({ type: 'system', subtype: 'status', session_id: 's', ...fields });
const boundary = (trigger: 'manual' | 'auto') => ({
  type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger, pre_tokens: 82_939, post_tokens: 1_719 },
});
const summaryMessage = {
  type: 'user', isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text:
    'This session is being continued from a previous conversation that ran out of context. The summary below covers '
    + 'the earlier portion of the conversation.\n\nSummary:\nThe user wants short replies.\n\n'
    + 'If you need specific details from before compaction, read the transcript.' }] },
};
const haiku = (input: number, output: number, read: number, write: number) =>
  ({ haiku: { inputTokens: input, outputTokens: output, cacheReadInputTokens: read, cacheCreationInputTokens: write } });
const result = (total: number, modelUsage: Record<string, unknown>, fields: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', result: '', num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  total_cost_usd: total, modelUsage, ...fields,
});

/** The outcome if it settles promptly, or 'pending': a broken mutant fails at once instead of hanging to the timeout. */
function within<T>(promise: Promise<T>, ms = 100): Promise<T | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))]);
}

function usage() {
  const settled: Array<{ id: string; usage: any }> = [];
  return { settled, sink: { requestStarted: () => 'compact:op:1', requestSettled: (id: string, u?: any) => { settled.push({ id, usage: u }); } } };
}

function request(sink: any, signal?: AbortSignal) {
  return {
    operationId: 'op', requestId: 'r', agentId: 'a', cause: 'automatic' as const, policy,
    before: { basis: 'unavailable' as const }, usage: sink, ...(signal ? { signal } : {}),
  };
}

async function started() {
  const spawn = fakeSpawn();
  const backend = new ClaudeHeadlessBackend(makeConfig(), undefined, undefined, { spawn: spawn.fn as any, compactionPolicy: () => policy });
  const events: any[] = [];
  backend.onEvent((event) => events.push(event));
  await backend.start({} as NodeJS.ProcessEnv);
  const writes: string[] = [];
  (backend as any).proc.stdin.write = (text: string) => { writes.push(text); return true; };
  const handle = (evt: unknown) => (backend as any).handleEvent(evt);
  // A first ordinary turn gives the process its cumulative baseline.
  await handle(result(0.030281, haiku(540, 100, 90_000, 31_000), { num_turns: 1, result: 'ok' }));
  events.length = 0;
  return { spawn, backend, events, writes, handle };
}

describe('Claude native compaction (v0.9.90 Slice 5)', () => {
  it('installs the agent\'s threshold in the child\'s environment only', async () => {
    const { spawn } = await started();
    expect(spawn.calls[0].options?.env).toMatchObject({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '357142', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' });
  });

  it('compacts through a /compact control turn and emits none of its events as chat or a turn', async () => {
    const { backend, events, writes, handle } = await started();
    const { settled, sink } = usage();
    const outcome = backend.contextControl.compact(request(sink));
    expect(writes).toEqual([JSON.stringify({ type: 'user', message: { role: 'user', content: '/compact' } }) + '\n']);
    await handle(status({ status: 'compacting' }));
    await handle(status({ status: null, compact_result: 'success' }));
    await handle({ type: 'system', subtype: 'init', session_id: 's' });
    await handle(boundary('manual'));
    await handle(summaryMessage);
    await handle({ type: 'user', isReplay: true, message: { role: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' } });
    await handle(result(0.037402, haiku(2_000, 900, 110_000, 33_000)));
    await expect(within(outcome)).resolves.toEqual({
      kind: 'compacted', mechanism: 'native-runtime', summary: 'The user wants short replies.',
      after: { basis: 'unavailable', window: 1_048_576, windowSource: 'assumed' },
    });
    expect(events.filter((e) => ['assistant', 'assistant_delta', 'turn_complete', 'model_request'].includes(e.kind))).toEqual([]);
    // One auxiliary unit, settled from the increase the control turn caused: its own result usage is zero.
    expect(settled).toHaveLength(1);
    expect(settled[0].usage).toMatchObject({ inputTokens: 1_460 + 20_000 + 2_000, outputTokens: 800, cachedInputTokens: 20_000, usageBasis: 'reported' });
    expect(settled[0].usage.costUsd).toBeCloseTo(0.007121, 6);
  });

  it('reports a failed compaction with the CLI\'s reason and swallows its synthetic reply', async () => {
    const { backend, events, handle } = await started();
    const { settled, sink } = usage();
    const outcome = backend.contextControl.compact(request(sink));
    await handle(status({ status: 'compacting' }));
    await handle(status({ status: null, compact_result: 'failed', compact_error: 'Not enough messages to compact.' }));
    await handle({ type: 'assistant', message: { id: 'synthetic', content: [{ type: 'text', text: 'Not enough messages to compact.' }] } });
    await handle(result(0.030281, haiku(540, 100, 90_000, 31_000), { result: 'Not enough messages to compact.' }));
    await expect(outcome).resolves.toEqual({ kind: 'failed', reason: 'native-failed', detail: 'Not enough messages to compact.' });
    expect(events.filter((e) => e.kind === 'assistant' || e.kind === 'turn_complete')).toEqual([]);
    expect(settled).toHaveLength(1);
  });

  it('remembers a CLI that answers /compact without compacting, and stops asking it', async () => {
    const { backend, writes, handle } = await started();
    const first = backend.contextControl.compact(request(usage().sink));
    await handle(result(0.030281, {}, { result: 'Unknown command' }));
    await expect(first).resolves.toMatchObject({ kind: 'failed', reason: 'native-unsupported' });
    await expect(within(backend.contextControl.compact(request(usage().sink)))).resolves.toMatchObject({ kind: 'failed', reason: 'native-unsupported' });
    expect(writes).toHaveLength(1);
  });

  it('stops waiting when the budget runs out, and still consumes the control turn\'s late events as its own', async () => {
    const { backend, events, handle } = await started();
    const budget = new AbortController();
    const outcome = backend.contextControl.compact(request(usage().sink, budget.signal));
    budget.abort();
    await expect(outcome).resolves.toMatchObject({ kind: 'failed', reason: 'timeout' });
    backend.sendUserTurn('next task');
    await handle(status({ status: 'compacting' }));
    await handle(status({ status: null, compact_result: 'success' }));
    await handle(result(0.037402, {}));
    expect(events.filter((e) => e.kind === 'turn_complete')).toEqual([]);
    // The ordinary turn's own result comes next and completes it normally.
    await handle(result(0.04, {}, { num_turns: 1, result: 'done' }));
    expect(events.filter((e) => e.kind === 'turn_complete')).toHaveLength(1);
  });

  it('never compacts on request inside a turn', async () => {
    const { backend } = await started();
    backend.sendUserTurn('work');
    expect(() => backend.contextControl.compact(request(usage().sink))).toThrow(/only between turns/);
  });

  it('reports a compaction Claude ran on its own inside a turn once, with its summary and installed policy', async () => {
    const { backend, events, handle } = await started();
    backend.sendUserTurn('long work');
    // A large request before the compaction gives the projection a baseline it must then drop.
    await handle({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_0', usage: { input_tokens: 10, cache_read_input_tokens: 82_000, cache_creation_input_tokens: 900, output_tokens: 1 } } } });
    expect(backend.contextControl.projectNextTurn('next')).toMatchObject({ basis: 'reported-plus-delta' });
    await handle(status({ status: 'compacting' }));
    await handle(status({ status: null, compact_result: 'success' }));
    await handle(boundary('auto'));
    await handle(summaryMessage);
    await handle({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'ok' }] } });
    await handle(result(0.19648, {}, { num_turns: 1, result: 'ok' }));
    const native = events.filter((e) => e.kind === 'native_compaction');
    expect(native).toHaveLength(1);
    expect(native[0]).toMatchObject({
      trigger: 'auto', before: { tokens: 82_939, basis: 'reported-plus-delta' }, after: { basis: 'unavailable' },
      summary: 'The user wants short replies.', policy,
    });
    expect(events.filter((e) => e.kind === 'assistant').map((e) => e.text)).toEqual(['ok']);
    expect(events.filter((e) => e.kind === 'turn_complete')).toHaveLength(1);
    // The pre-compaction request no longer describes the conversation: the next projection waits for a report.
    expect(backend.contextControl.projectNextTurn('next')).toMatchObject({ basis: 'unavailable' });
  });
});
