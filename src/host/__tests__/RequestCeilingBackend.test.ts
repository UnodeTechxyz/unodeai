import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { OpenAICompatBackend, type FetchFn } from '../../backend/OpenAICompatBackend';
import type { BackendEvent } from '../../backend/AgentBackend';
import type { AgentConfig } from '../../types';
import {
  RequestCeilingGate,
  type RequestCeilingDecision,
  type RequestCeilingDecisionFacts,
  type RequestLimits,
} from '../RequestCeiling';
import { agentRequestBoundary } from '../RequestLimitBinding';

/* v0.9.94: the gate and a real in-process backend together, bound the way a host binds them: the boundary is
   the gate's, a model request the backend reports is counted, and Stop reaches the backend's own stop path. */

const REQUEST = 'request-1';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

interface OpenPrompt {
  facts: RequestCeilingDecisionFacts;
  signal: AbortSignal;
  answer(decision: RequestCeilingDecision): void;
}

const write = (file: string) => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [
    { id: `call-${file}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: file, content: file }) } },
  ] } }],
  usage: { prompt_tokens: 100, completion_tokens: 10 },
});
const list = () => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [
    { id: 'call-list', type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } },
  ] } }],
  usage: { prompt_tokens: 100, completion_tokens: 10 },
});
const reply = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 10 } });

/** One limited request and its gate. Its agents are added with `member`, each a real in-process backend. */
function team(limits: RequestLimits) {
  const prompts: OpenPrompt[] = [];
  const stops: string[] = [];
  /** Every model request that left, by the agent that sent it. */
  const left: string[] = [];
  const backends: OpenAICompatBackend[] = [];
  const gate = new RequestCeilingGate({
    readLimits: () => limits,
    decide: (facts, signal) => new Promise<RequestCeilingDecision>((resolve) => { prompts.push({ facts, signal, answer: resolve }); }),
    // The host's ordinary stop path for this request: stop every agent's turn of it.
    stopRequest: (requestId) => {
      stops.push(requestId);
      for (const backend of backends) backend.abort();
    },
    reachableRequests: () => new Set([REQUEST]),
    timers: { set: () => 0, clear: () => undefined },
  });
  gate.begin(REQUEST);

  async function member(agentId: string, responses: unknown[]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-ceiling-backend-'));
    dirs.push(dir);
    const fetched: number[] = [];
    let index = 0;
    const fetchFn: FetchFn = async () => {
      fetched.push(index);
      left.push(agentId);
      const body = responses[Math.min(index++, responses.length - 1)];
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const config: AgentConfig = {
      id: agentId, name: agentId, role: 'senior-dev', skill: '',
      provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
      model: 'deepseek-chat', systemPrompt: 'Be terse.', autoApprove: true, allowedTools: ['read', 'write'],
      workingDirectory: dir,
    };
    // The boundary the host hands a backend: the request of that agent's running turn, asked at the gate.
    const boundary = agentRequestBoundary(agentId, {
      gate: () => gate,
      currentRequestId: () => REQUEST,
      personWait: (_agentId, wait) => wait(),
    });
    const backend = new OpenAICompatBackend(config, fetchFn, undefined, undefined, undefined, { retryBaseMs: 0, onRequestBoundary: boundary });
    backends.push(backend);
    const events: BackendEvent[] = [];
    const unit = { input: 0, output: 0 };
    const done = new Promise<Extract<BackendEvent, { kind: 'turn_complete' }>>((resolve) => {
      backend.onEvent((event) => {
        events.push(event);
        if (event.kind === 'model_request') gate.noteProviderRequest(REQUEST, agentId, 'request');
        // A progress event carries one response's own figures; the gate is given the unit's running total.
        if (event.kind === 'usage_progress') {
          unit.input += event.inputTokens;
          unit.output += event.outputTokens;
          gate.noteUsage(REQUEST, `${agentId}-unit`, unit);
        }
        if (event.kind === 'turn_complete') resolve(event);
      });
    });
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    return { backend, fetched, events, done, dir };
  }
  return { gate, prompts, stops, left, member };
}

async function bound(limits: RequestLimits, responses: unknown[]) {
  const { gate, prompts, stops, member } = team(limits);
  const agent = await member('a1', responses);
  agent.backend.sendUserTurn('go');
  return { gate, prompts, stops, ...agent };
}

async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !condition(); turn++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(condition()).toBe(true);
}

const exists = (file: string) => fs.access(file).then(() => true, () => false);

describe('RequestCeilingGate bound to an in-process backend', () => {
  it('with a limit of one lets one of two teammates that ask together send its request, and holds the other', async () => {
    const { gate, prompts, stops, left, member } = team({ providerTurns: 1 });
    const dev = await member('dev', [reply('dev done')]);
    const reviewer = await member('reviewer', [reply('reviewer done')]);
    // Both turns start before either request has been counted.
    dev.backend.sendUserTurn('go');
    reviewer.backend.sendUserTurn('go');
    await until(() => prompts.length === 1);

    // Exactly one request left. The other is held: it was not sent on the count the first one had already taken.
    expect(left).toEqual(['dev']);
    expect(reviewer.fetched).toEqual([]);
    expect(prompts[0].facts).toMatchObject({
      reached: [{ limit: 'providerTurns', configured: 1, allowance: 1, observed: 1 }],
      limits: { heldBoundary: 'provider-request', decision: 'awaiting' },
    });
    expect((await dev.done).result.text).toBe('dev done');

    prompts[0].answer('stop');
    expect((await reviewer.done).result.responseOutcome).toEqual({ kind: 'stopped' });
    expect(left).toEqual(['dev']);
    expect(stops).toEqual([REQUEST]);
    expect(gate.facts(REQUEST)).toMatchObject({ providerTurns: { ceiling: 1, observed: 1 }, decision: 'stopped' });
  });

  it('after Continue sends the held teammate\'s request, and counts each request once', async () => {
    const { gate, prompts, left, member } = team({ providerTurns: 1 });
    const dev = await member('dev', [reply('dev done')]);
    const reviewer = await member('reviewer', [reply('reviewer done')]);
    dev.backend.sendUserTurn('go');
    reviewer.backend.sendUserTurn('go');
    await until(() => prompts.length === 1);
    prompts[0].answer('continue');

    expect((await reviewer.done).result.text).toBe('reviewer done');
    expect((await dev.done).result.text).toBe('dev done');
    expect(left).toEqual(['dev', 'reviewer']);
    expect(gate.facts(REQUEST)).toMatchObject({ providerTurns: { ceiling: 1, observed: 2 }, crossings: 1, allowances: 1, decision: 'continued' });
  });

  it('lets two model requests leave, holds the third, and sends it after Continue', async () => {
    const { gate, prompts, stops, fetched, events, done, dir } = await bound({ providerTurns: 2 }, [write('one.txt'), list(), reply('done')]);
    await until(() => prompts.length === 1);
    // Two requests left and both responses were finished: the write of the first ran inside the limit, and the
    // listing the second asked for is a read, which is never held. The third request is what waits.
    expect(fetched).toEqual([0, 1]);
    expect(await exists(path.join(dir, 'one.txt'))).toBe(true);
    expect(events.filter((event) => event.kind === 'tool_result').map((event) => (event as { name: string }).name)).toEqual(['write_file', 'list_dir']);
    expect(prompts[0].facts).toMatchObject({
      reached: [{ limit: 'providerTurns', configured: 2, allowance: 2, observed: 2 }],
      limits: { decision: 'awaiting', heldBoundary: 'provider-request', crossings: 1, allowances: 0 },
    });

    prompts[0].answer('continue');
    expect((await done).result.text).toBe('done');
    expect(fetched).toEqual([0, 1, 2]);
    expect(stops).toEqual([]);
    expect(gate.facts(REQUEST)).toEqual({
      coverage: 'complete',
      providerTurns: { ceiling: 2, observed: 3 },
      crossings: 1,
      allowances: 1,
      decision: 'continued',
    });
  });

  it('ends the turn as a stop, sends nothing more, and asks the host once when the person stops the request', async () => {
    const { gate, prompts, stops, fetched, events, done } = await bound({ providerTurns: 1 }, [list(), reply('never sent')]);
    await until(() => prompts.length === 1);
    prompts[0].answer('stop');
    const result = (await done).result;
    expect(result.responseOutcome).toEqual({ kind: 'stopped' });
    expect(fetched).toEqual([0]);
    expect(stops).toEqual([REQUEST]);
    expect(events.some((event) => event.kind === 'error')).toBe(false);
    // The usage of the response that did complete is kept.
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    expect(gate.facts(REQUEST)).toMatchObject({ decision: 'stopped', providerTurns: { ceiling: 1, observed: 1 }, heldBoundary: 'provider-request' });
  });

  it('holds the write that follows a response which took the tokens to the limit', async () => {
    const { gate, prompts, fetched, done, dir } = await bound({ tokens: 110 }, [write('one.txt'), reply('done')]);
    await until(() => prompts.length === 1);
    // The response that reached the limit was finished; the effect it asked for is what is held.
    expect(fetched).toEqual([0]);
    expect(prompts[0].facts.reached).toEqual([{ limit: 'tokens', configured: 110, allowance: 110, observed: 110 }]);
    expect(prompts[0].facts.limits.heldBoundary).toBe('effect');
    expect(await exists(path.join(dir, 'one.txt'))).toBe(false);

    prompts[0].answer('continue');
    expect((await done).result.text).toBe('done');
    expect(await exists(path.join(dir, 'one.txt'))).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(gate.facts(REQUEST)).toMatchObject({ tokens: { ceiling: 110, observed: 220 }, crossings: 1, allowances: 1 });
  });

  it('holds the write a response asked for once the provider-turn limit is reached, and refuses it on Stop', async () => {
    const { gate, prompts, stops, fetched, events, done, dir } = await bound({ providerTurns: 1 }, [write('one.txt'), reply('never sent')]);
    await until(() => prompts.length === 1);
    expect(prompts[0].facts.limits.heldBoundary).toBe('effect');
    expect(await exists(path.join(dir, 'one.txt'))).toBe(false);
    prompts[0].answer('stop');
    expect((await done).result.responseOutcome).toEqual({ kind: 'stopped' });
    expect(await exists(path.join(dir, 'one.txt'))).toBe(false);
    expect(events.find((event) => event.kind === 'tool_result')).toMatchObject({ outcome: { status: 'refused', observedBy: 'host', reason: 'safety-limit' } });
    expect(fetched).toEqual([0]);
    expect(stops).toEqual([REQUEST]);
    expect(gate.facts(REQUEST)).toMatchObject({ decision: 'stopped', heldBoundary: 'effect' });
  });

  it('closes the prompt when the person stops the agent instead of answering it', async () => {
    const { gate, backend, prompts, stops, fetched, done, dir } = await bound({ providerTurns: 1 }, [write('one.txt'), reply('never sent')]);
    await until(() => prompts.length === 1);
    backend.abort();
    expect((await done).result.responseOutcome).toEqual({ kind: 'stopped' });
    expect(prompts[0].signal.aborted).toBe(true);
    expect(await exists(path.join(dir, 'one.txt'))).toBe(false);
    expect(fetched).toEqual([0]);
    // Nobody answered the limit: the gate did not stop the request, the person stopped the agent.
    expect(stops).toEqual([]);
    expect(gate.facts(REQUEST)).toMatchObject({ decision: 'none', crossings: 1, allowances: 0 });
  });
});
