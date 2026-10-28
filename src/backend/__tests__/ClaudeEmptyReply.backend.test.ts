import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeHeadlessBackend } from '../ClaudeHeadlessBackend';
import type { AgentConfig } from '../../types';
import type { BackendEvent, TurnAttachments } from '../AgentBackend';
import * as composition from '../RequestComposition';
import { estimateTokens } from '../TokenCounter';

function makeConfig(): AgentConfig {
  return {
    id: 'claude-1', name: 'Claude Dev', role: 'developer', skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'claude-sonnet-4-5', systemPrompt: 'Follow the role.', autoApprove: true, allowedTools: [],
    backend: 'claude', workingDirectory: process.cwd(),
  };
}

function fakeSpawn() {
  return (_cmd: string, _args: string[]) => {
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
}

/** A terminal result as Claude CLI 2.1.209 reports it; `total` is the process's cumulative cost. */
const result = (text: string, total: number, fields: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: total,
  usage: { input_tokens: 10, cache_read_input_tokens: 246_000, cache_creation_input_tokens: 658, output_tokens: 16 },
  ...fields,
});

async function openTurn(attachments?: TurnAttachments) {
  const backend = new ClaudeHeadlessBackend(makeConfig(), undefined, undefined, { spawn: fakeSpawn() as any });
  const events: any[] = [];
  backend.onEvent((event) => events.push(event));
  await backend.start({} as NodeJS.ProcessEnv, { pin: 'take' });
  const writes: string[] = [];
  (backend as any).proc.stdin.write = (text: string) => { writes.push(text); return true; };
  const handle = (evt: unknown) => (backend as any).handleEvent(evt);
  backend.sendUserTurn('write the file', attachments);
  return { backend, events, writes, handle, completions: () => events.filter((event) => event.kind === 'turn_complete') };
}

describe('Claude empty-reply outcome (v0.9.90 §7)', () => {
  it('logs only the actual host packets, with composer categories and unchanged bytes on the blank retry', async () => {
    const attachments: TurnAttachments = { projectContext: 'PRIVATE_CONTEXT '.repeat(100), files: ['PRIVATE_PATH'],
      userAttachments: [{ kind: 'file', name: 'PRIVATE_FILE', mime: 'text/plain', dataBase64: Buffer.from('PRIVATE_FILE_TEXT '.repeat(50)).toString('base64') },
        { kind: 'image', name: 'PRIVATE_IMAGE', mime: 'image/png', dataBase64: 'UFJJVkFURQ==' }] };
    const { backend, events, writes, handle } = await openTurn(attachments);
    const submitted = () => (events as BackendEvent[]).filter((event): event is Extract<BackendEvent, { kind: 'request_composition' }> => event.kind === 'request_composition');
    expect(submitted()).toHaveLength(1);
    const first = submitted()[0].measurement;
    expect(first?.boundary).toBe('host-turn-submit');
    if (first?.boundary !== 'host-turn-submit') throw new Error('missing actual host composition');
    const text = JSON.parse(writes[0]).message.content[0].text;
    expect(first).toMatchObject({ body_utf8_bytes: Buffer.byteLength(writes[0]), internal_requests: 'not-observable',
      history_text: 'not-observable', reported_input_tokens: 'not-observable', installed_tools_estimate: 'not-observable' });
    expect(first.host_observed_total).toBe(estimateTokens(text) + 256);
    for (const key of ['system', 'turn_input', 'attachments', 'host_context'] as const) expect(first.host_observed[key]).toBeGreaterThan(0);
    expect(first.host_observed.system).toBeLessThan(estimateTokens('PRIVATE_CONTEXT '.repeat(100)));
    expect(JSON.stringify(first)).not.toContain('PRIVATE_');
    (backend as any).config.systemPrompt = 'PRIVATE_NEW_CONFIGURATION '.repeat(1000);
    await handle(result('', 0.1));
    expect(writes[1]).toBe(writes[0]);
    expect(submitted().map(event => event.attempt)).toEqual([1, 2]);
    expect(submitted()[1].measurement).toEqual(first);
    await handle(result('done', 0.2));
    backend.sendUserTurn('next', attachments);
    expect(submitted().map(event => event.attempt)).toEqual([1, 2, 1]);
    const next = submitted()[2].measurement;
    if (next?.boundary !== 'host-turn-submit') throw new Error('missing continuation composition');
    expect(next.host_observed.system).toBe(0);
    expect(next.host_observed.host_context).toBeGreaterThan(0);
    expect(writes[2]).not.toContain('PRIVATE_NEW_CONFIGURATION');
    await handle(result('next done', 0.3));
  });

  it('an estimator or diagnostic sink failure cannot change a Claude packet or consume a retry', async () => {
    const original = await openTurn();
    await original.handle(result('done', 0.1));
    const spy = vi.spyOn(composition, 'projectHostSubmitComposition').mockImplementation(() => { throw new Error('PRIVATE_ESTIMATOR'); });
    try {
      const observed = await openTurn();
      observed.backend.onEvent(event => { if (event.kind === 'request_composition') throw new Error('PRIVATE_LOGGER'); });
      await observed.handle(result('', 0.1));
      expect(observed.writes).toEqual([original.writes[0], original.writes[0]]);
      expect(observed.events.filter(event => event.kind === 'request_composition').map(event => event.measurement)).toEqual([undefined, undefined]);
      await observed.handle(result('done', 0.2));
      expect(observed.completions()[0].result).toMatchObject({ text: 'done', isError: false });
    } finally { spy.mockRestore(); }
  });

  it('writes a blank attempt again byte for byte, then names a second blank an empty reply charged for both', async () => {
    const { events, writes, handle, completions } = await openTurn();
    // Hidden reasoning with 16 output tokens is still nothing visible.
    await handle({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } });
    await handle(result('', 0.10, { uuid: 'r1' }));
    expect(completions()).toEqual([]);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe(writes[0]);
    expect(events.filter((event) => event.kind === 'model_request')).toHaveLength(2);
    await handle(result('', 0.20, { uuid: 'r2' }));
    expect(completions()).toHaveLength(1);
    const final = completions()[0].result;
    expect(final.responseOutcome).toEqual({
      kind: 'empty-reply',
      attempts: [
        { attempt: 1, gateway: 'claude-cli', inputBasis: 'reported', inputTokens: 246_668, outputTokens: 16, finishSignal: 'success', responseId: 'r1' },
        { attempt: 2, gateway: 'claude-cli', inputBasis: 'reported', inputTokens: 246_668, outputTokens: 16, finishSignal: 'success', responseId: 'r2' },
      ],
    });
    expect(final.usage).toMatchObject({ inputTokens: 493_336, outputTokens: 32, attributedAttempts: 2 });
    expect(final.usage.costUsd).toBeCloseTo(0.20, 6);
  });

  it('is a reply when the second attempt answers', async () => {
    const { handle, completions } = await openTurn();
    await handle(result('', 0.10));
    await handle({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'done' }] } });
    await handle(result('done', 0.20));
    expect(completions()).toHaveLength(1);
    expect(completions()[0].result).toMatchObject({ text: 'done', responseOutcome: { kind: 'reply' }, usage: { attributedAttempts: 2 } });
  });

  it('never repeats an attempt that used a tool, and calls it tool-only', async () => {
    const { writes, handle, completions } = await openTurn();
    await handle({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }] } });
    await handle(result('', 0.10));
    expect(writes).toHaveLength(1);
    expect(completions()[0].result.responseOutcome).toEqual({ kind: 'tool-only' });
  });

  it('never repeats an attempt that asked a person for approval', async () => {
    const { backend, writes, handle, completions } = await openTurn();
    await (backend as any).awaitHumanDecision(Promise.resolve({ allow: false }), () => ({ allow: false }));
    await handle(result('', 0.10));
    expect(writes).toHaveLength(1);
    expect(completions()[0].result.responseOutcome).toEqual({ kind: 'tool-only' });
  });

  it('never retries an error result as blank', async () => {
    const { writes, handle, completions } = await openTurn();
    await handle(result('', 0.10, { subtype: 'error_during_execution', is_error: true }));
    expect(writes).toHaveLength(1);
    expect(completions()[0].result).toMatchObject({ isError: true, responseOutcome: { kind: 'error' } });
  });

  it('never retries once the agent is being stopped', async () => {
    const { backend, writes, handle } = await openTurn();
    (backend as any).startCancelled = true;
    await handle(result('', 0.10));
    expect(writes).toHaveLength(1);
  });

  it('records blank attempts without reported usage as unavailable, and settles no invented usage', async () => {
    const { handle, completions } = await openTurn();
    await handle(result('', 0.10, { usage: undefined }));
    await handle(result('', 0.20, { usage: undefined }));
    const final = completions()[0].result;
    expect(final.responseOutcome).toMatchObject({ kind: 'empty-reply', attempts: [{ inputBasis: 'unavailable' }, { inputBasis: 'unavailable' }] });
    expect(final.responseOutcome.attempts[0].inputTokens).toBeUndefined();
    expect(final.usage).toBeUndefined();
  });
});
