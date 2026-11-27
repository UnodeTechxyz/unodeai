import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatBackend, type ChatMessage, type FetchFn } from '../OpenAICompatBackend';
import type { BackgroundCompaction, ContextCompactionRequest } from '../ContextControl';
import { TokenCounter } from '../TokenCounter';
import type { AgentConfig } from '../../types';
import { bundledSmartCompactionPolicy } from '../../compaction/BundledSmartCompactionPolicy';
import { resolveSmartCompactionPolicy, type ResolvedSmartCompactionPolicy } from '../../compaction/SmartCompactionPolicy';
import type { ChunkedSummaryRequest, ChunkedSummaryResult } from '../../compaction/MapReduceSummarizer';
import { buildHistoricalReadFact } from '../../compaction/ReadReferenceProjection';

/**
 * v0.9.99 P6: a compaction captured at an idle boundary, prepared while the agent works, and applied at a later idle
 * boundary to the history as it then stands.
 */
function makeConfig(): AgentConfig {
  return {
    id: 'a1', name: 'Worker', role: 'senior-dev', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-chat', systemPrompt: 'Be terse.', autoApprove: true, allowedTools: [], workingDirectory: process.cwd(),
  };
}
const neverFetch: FetchFn = async () => { throw new Error('no provider request is expected'); };

function balancedPolicy(): ResolvedSmartCompactionPolicy {
  const resolved = resolveSmartCompactionPolicy({
    policy: bundledSmartCompactionPolicy(),
    agent: { roleTemplateKey: 'pm' },
    contextWindow: { tokens: 1_048_576, source: 'assumed' },
  });
  if (resolved.status !== 'resolved') throw new Error('bundled policy did not resolve');
  return resolved.policy;
}

/** A summarizer whose answer the test releases, so the work around it can be observed while it is pending. */
function heldSummarizer(result: ChunkedSummaryResult = { ok: true, summary: 'Earlier work.' }) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const summarizeChunks = vi.fn(async (_request: ChunkedSummaryRequest) => { await released; return result; });
  return { summarizer: { summarizeChunks }, release, summarizeChunks };
}

function request(host: ReturnType<typeof heldSummarizer>, cause: 'automatic' | 'manual' = 'automatic'): ContextCompactionRequest {
  return {
    operationId: 'op1', requestId: 'req1', agentId: 'a1', cause, policy: balancedPolicy(),
    before: { basis: 'unavailable' },
    pendingTurn: { instruction: 'Write the next file.' },
    usage: { requestStarted: () => 'u', requestSettled: () => undefined },
    hostSummarizer: { summarizer: host.summarizer, io: { chatCompletion: async () => ({ text: '' }) }, model: 'economy', contextWindow: 128_000 },
  };
}

/** `turns` user/assistant pairs of about 2,000 tokens each, after the system prompt. */
function longHistory(turns: number): ChatMessage[] {
  const history: ChatMessage[] = [{ role: 'system', content: 'Be terse.' }];
  for (let turn = 0; turn < turns; turn++) {
    history.push({ role: 'user', content: `task ${turn} `.padEnd(8_000, 'u') });
    history.push({ role: 'assistant', content: `done ${turn} `.padEnd(8_000, 'a') });
  }
  return history;
}

function seeded(turns = 75): { backend: OpenAICompatBackend; history: () => ChatMessage[] } {
  const backend = new OpenAICompatBackend(makeConfig(), neverFetch);
  const original = longHistory(turns);
  (backend as any).history = original;
  (backend as any).conversationRecord = structuredClone(original);
  return { backend, history: () => (backend as any).history };
}

function captured(backend: OpenAICompatBackend, host: ReturnType<typeof heldSummarizer>): BackgroundCompaction {
  const result = backend.contextControl.captureCompaction!(request(host));
  if (!('prepare' in result)) throw new Error(`nothing captured: ${JSON.stringify(result)}`);
  return result;
}

describe('background compaction phases (v0.9.99 P6)', () => {
  it('prepares without marking the backend busy or touching its history, then applies and keeps what was appended since', async () => {
    const { backend, history } = seeded();
    const host = heldSummarizer();
    const job = captured(backend, host);
    const before = history().slice();
    // The estimate is of the records to summarize: more than nothing, less than the whole conversation.
    expect(job.estimatedInputTokens).toBeGreaterThan(0);
    expect(job.estimatedInputTokens).toBeLessThan(new TokenCounter().estimateMessages(before));
    const preparing = job.prepare();
    // While the summary is pending the agent may work: it is not busy, and its history is unchanged.
    expect((backend as any).busy).toBe(false);
    expect(history()).toEqual(before);
    const appended: ChatMessage[] = [{ role: 'user', content: 'a new task' }, { role: 'assistant', content: 'on it' }];
    history().push(...appended);
    host.release();
    expect(await preparing).toEqual({ kind: 'prepared' });
    expect(job.prepare()).toBe(preparing);

    const result = job.commit({ instruction: 'next' });
    expect(result).toMatchObject({ kind: 'compacted', mechanism: 'host-history', summary: 'Earlier work.' });
    const after = history();
    expect(after[0]).toBe(before[0]);
    expect(after[1].content).toContain('Earlier work.');
    // The messages appended after the capture are the very same objects, last and in order.
    expect(after.slice(-2)).toEqual(appended);
    expect(after.at(-1)).toBe(appended[1]);
    expect(after.length).toBeLessThan(before.length);
    expect(host.summarizeChunks).toHaveBeenCalledTimes(1);
  });

  it('keeps the read provenance of a message appended after the capture', async () => {
    const { backend, history } = seeded();
    const host = heldSummarizer();
    const job = captured(backend, host);
    const text = 'file text '.repeat(20);
    const read: ChatMessage = { role: 'tool', tool_call_id: 'r1', content: text, hostIdentity: { messageId: 'm', turnId: 't' },
      historicalRead: buildHistoricalReadFact({ source: { kind: 'file', path: 'a.ts', representation: 'text' },
        rerun: { tool: 'read_file', args: { path: 'a.ts' } }, resultText: text, span: { start: 0, end: text.length }, truncated: false }) };
    history().push({ role: 'assistant', content: null, tool_calls: [{ id: 'r1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] }, read);
    host.release();
    await job.prepare();
    expect(job.commit()).toMatchObject({ kind: 'compacted' });
    expect(history().at(-1)).toBe(read);
    expect(history().at(-1)!.historicalRead).toBe(read.historicalRead);
  });

  it('applies nothing when a captured message was replaced, edited in place, or the history was restored', async () => {
    const changes: Array<(backend: OpenAICompatBackend, history: ChatMessage[]) => void> = [
      (_backend, history) => { history[3] = { ...history[3] }; },
      (_backend, history) => { history[3].content = 'edited'; },
      (_backend, history) => { history.splice(1, 2); },
      (backend) => { backend.restore({ version: 3, backend: 'openai-compat', hostTurnState: 'complete', completedMessageCount: 1, messages: [{ role: 'system', content: 'x' }] }); },
      // A new projection generation (a restore or a compaction) is stale even where the objects happen to remain.
      (backend) => { (backend as any).readProjection = { ...(backend as any).readProjection, generation: (backend as any).readProjection.generation + 1 }; },
    ];
    for (const change of changes) {
      const { backend, history } = seeded();
      const host = heldSummarizer();
      const job = captured(backend, host);
      const preparing = job.prepare();
      change(backend, history());
      const unchanged = history().slice();
      host.release();
      await preparing;
      expect(job.commit()).toMatchObject({ kind: 'failed', reason: 'stale' });
      expect(history()).toEqual(unchanged);
    }
  });

  it('applies nothing when the history grew so much that the result would not land below the trigger', async () => {
    const { backend, history } = seeded();
    const host = heldSummarizer();
    const job = captured(backend, host);
    history().push(...longHistory(130).slice(1));
    const unchanged = history().slice();
    host.release();
    await job.prepare();
    expect(job.commit()).toMatchObject({ kind: 'failed', reason: 'required-context-too-large' });
    expect(history()).toEqual(unchanged);
  });

  it('says a summary that is not ready yet was not applied, and is applied only once', async () => {
    const { backend, history } = seeded();
    const host = heldSummarizer();
    const job = captured(backend, host);
    const preparing = job.prepare();
    expect(job.commit()).toMatchObject({ kind: 'failed', reason: 'stale' });
    host.release();
    await preparing;
    expect(job.commit()).toMatchObject({ kind: 'compacted' });
    const once = history().slice();
    expect(job.commit()).toMatchObject({ kind: 'failed', reason: 'stale' });
    expect(history()).toEqual(once);
  });

  it('reports a failed summary as failed, and never captures or applies inside a turn', async () => {
    const { backend } = seeded();
    const failing = heldSummarizer({ ok: false, reason: 'summarizer-failed', detail: 'HTTP 500' });
    const job = captured(backend, failing);
    failing.release();
    expect(await job.prepare()).toMatchObject({ kind: 'failed', reason: 'summarizer-failed' });
    (backend as any).busy = true;
    expect(() => backend.contextControl.captureCompaction!(request(heldSummarizer()))).toThrow(/between turns/);
    expect(() => job.commit()).toThrow(/between turns/);
  });

  it('returns a result instead of a handle when there is nothing to prepare', () => {
    const { backend } = seeded(3);
    expect(backend.contextControl.captureCompaction!(request(heldSummarizer(), 'manual'))).toEqual({ kind: 'skipped', reason: 'nothing-droppable' });
  });

  it('projects the admissible budget and whether the next turn moves the read cutoff', () => {
    const { backend } = seeded(3);
    const projection = backend.contextControl.projectNextTurn('next');
    expect(projection).toMatchObject({ admissibleTokens: (backend as any).tokenCounter.hardLimit(), readProjectionMoves: false });

    // A read of 50,000 CJK characters two turns back saves more than 40,000 tokens: the next turn moves the cutoff.
    const text = '文'.repeat(50_000);
    const id = (messageId: string, turnId: string) => ({ messageId, turnId });
    const reading = new OpenAICompatBackend(makeConfig(), neverFetch);
    (reading as any).history = [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'read it', hostIdentity: id('m1', 't1') },
      { role: 'assistant', content: null, hostIdentity: id('m2', 't1'),
        tool_calls: [{ id: 'r1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'r1', content: text, hostIdentity: id('m3', 't1'),
        historicalRead: buildHistoricalReadFact({ source: { kind: 'file', path: 'a.txt', representation: 'text' },
          rerun: { tool: 'read_file', args: { path: 'a.txt' } }, resultText: text, span: { start: 0, end: text.length }, truncated: false }) },
      { role: 'assistant', content: 'read', hostIdentity: id('m4', 't1') },
      { role: 'user', content: 'and?', hostIdentity: id('m5', 't2') },
      { role: 'assistant', content: 'ok', hostIdentity: id('m6', 't2') },
    ];
    expect(reading.contextControl.projectNextTurn('next')).toMatchObject({ readProjectionMoves: true });
  });
});
