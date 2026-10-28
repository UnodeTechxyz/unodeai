import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatBackend, type ChatMessage, type FetchFn } from '../OpenAICompatBackend';
import { estimateTokens, TokenCounter } from '../TokenCounter';
import { NativeToolProtocol } from '../toolProtocol/NativeToolProtocol';
import { XmlToolProtocol } from '../toolProtocol/XmlToolProtocol';
import type { ConversationSnapshot, TurnAttachments } from '../AgentBackend';
import { formatRequestComposition, type RequestComposition } from '../RequestComposition';
import type { AgentConfig } from '../../types';
import type { ContextCompactionRequest } from '../ContextControl';
import { bundledSmartCompactionPolicy } from '../../compaction/BundledSmartCompactionPolicy';
import { resolveSmartCompactionPolicy } from '../../compaction/SmartCompactionPolicy';
import type { ChunkedSummaryRequest } from '../../compaction/MapReduceSummarizer';
import { buildHistoricalReadFact, READ_REFERENCE_HEADER, type HistoricalReadFact } from '../../compaction/ReadReferenceProjection';
import { renderRollingSummary } from '../../compaction/HistoryCompactionPlanner';

/**
 * v0.9.99 P1: once the reads before the previous turn would save more than 40,000 tokens, every later request
 * carries them as references. Each read is bounded to 24,000 characters and the estimate counts a CJK character as
 * one token, so three CJK files of about 20,000 characters cross that line with real reads.
 */
let dir: string;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-read-projection-')));
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

/** 200 lines, each named by its file and number, of 96 CJK characters. */
function cjkFile(name: string): string {
  return Array.from({ length: 200 }, (_, index) => `${name}${index + 1}:${'文'.repeat(96)}`).join('\n');
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'a1', name: 'Worker', role: 'senior-dev', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-chat', systemPrompt: 'Be terse.', autoApprove: true, allowedTools: ['read'],
    workingDirectory: dir, ...overrides,
  };
}

type Response = Record<string, unknown>;
const reply = (content: string): Response => ({ choices: [{ message: { role: 'assistant', content } }] });
const nativeRead = (id: string, file: string): Response => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: file }) } }] } }],
});
const xmlRead = (file: string): Response => reply(`<read_file><path>${file}</path></read_file>`);

function scripted(responses: Response[]): { fetchFn: FetchFn; requests: any[] } {
  const requests: any[] = [];
  const fetchFn: FetchFn = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const next = responses.shift() ?? reply('ok');
    return { ok: true, status: 200, text: async () => JSON.stringify(next) };
  };
  return { fetchFn, requests };
}

async function started(fetchFn: FetchFn, overrides: Partial<AgentConfig> = {}): Promise<OpenAICompatBackend> {
  const backend = new OpenAICompatBackend(makeConfig(overrides), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
  await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
  return backend;
}

async function turn(backend: OpenAICompatBackend, instruction: string, attachments?: TurnAttachments): Promise<void> {
  await new Promise<void>((resolve) => {
    const off = backend.onEvent((event) => {
      if (event.kind === 'turn_complete') { off?.(); resolve(); }
    });
    backend.sendUserTurn(instruction, attachments);
  });
}

function requestEstimate(body: { messages: ChatMessage[]; tools?: unknown }): number {
  return new TokenCounter().estimateMessages(body.messages) + (body.tools ? estimateTokens(JSON.stringify(body.tools)) : 0);
}

/** A message's text; the last history message of a request can carry it as parts, for its cache breakpoint. */
const textOf = (message: ChatMessage): string => typeof message.content === 'string'
  ? message.content
  : (message.content ?? []).map((part) => part.type === 'text' ? part.text : '').join('');
/** The request messages that hold a read of `file`, whether as the full result or as a reference. */
const readsOf = (body: { messages: ChatMessage[] }, file: string): string[] => body.messages.map(textOf)
  .filter((text) => text.includes(`${file}1:`));

async function writeThreeFiles(): Promise<void> {
  for (const name of ['a', 'b', 'c']) await fs.writeFile(path.join(dir, `${name}.txt`), cjkFile(name), 'utf8');
}

describe('earlier reads become references (v0.9.99 P1)', () => {
  it('sends reads from before the previous turn as references, measured and frozen as they are sent', async () => {
    await writeThreeFiles();
    const { fetchFn, requests } = scripted([
      nativeRead('r1', 'a.txt'), nativeRead('r2', 'b.txt'), nativeRead('r3', 'c.txt'), reply('read all three'),
      reply('noted'),
      nativeRead('r4', 'a.txt'), reply('reread a'),
    ]);
    const backend = await started(fetchFn);
    await turn(backend, 'read a, b and c');
    await turn(backend, 'anything else?');
    // The second turn still sends every read in full: they belong to the previous turn.
    expect(readsOf(requests[4], 'a').join('')).toContain('a200:');
    const projection = backend.contextControl.projectNextTurn('look again');
    await turn(backend, 'look again');

    const third = requests[5];
    for (const file of ['a', 'b', 'c']) {
      const [reference] = readsOf(third, file);
      expect(reference).toContain(READ_REFERENCE_HEADER);
      // The host's receipt line stays; only the payload is replaced, by the excerpt that starts it.
      expect(reference.startsWith('[host content receipt: ')).toBe(true);
      expect(reference).toContain(`${file}1:`);
      expect(reference).not.toContain(`${file}200:`);
      expect(JSON.parse(reference.slice(reference.indexOf('\n{') + 1))).toMatchObject({
        kind: 'file', path: `${file}.txt`, rerun: { tool: 'read_file', args: { path: `${file}.txt` } },
      });
    }
    // The projection measured the request the turn sent.
    expect(projection.tokens).toBe(requestEstimate(third));
    expect(projection.tokens).toBeLessThan(requestEstimate(requests[4]));
    // Inside the turn the view holds: the next request repeats the first one's messages (the last moves only its cache
    // breakpoint), then adds the new read in full.
    const fourth = requests[6];
    expect(fourth.messages.slice(0, third.messages.length - 1)).toEqual(third.messages.slice(0, -1));
    expect(readsOf(fourth, 'a').at(-1)).toContain('a200:');
    // No host metadata reaches the provider.
    for (const body of requests) {
      expect(JSON.stringify(body)).not.toMatch(/hostIdentity|historicalRead|hostOutcome/);
    }
    // The history the view is projected from keeps the full text, and so does the record.
    const history: ChatMessage[] = (backend as any).history;
    expect(history.map(textOf).filter((text) => text.includes('a200:'))).toHaveLength(2);
    expect(history.filter((message) => message.historicalRead)).toHaveLength(4);
  });

  it('keeps every read in full while the reads before the previous turn would save 40,000 tokens or less', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), cjkFile('a'), 'utf8');
    const { fetchFn, requests } = scripted([nativeRead('r1', 'a.txt'), reply('read'), reply('noted'), reply('still here')]);
    const backend = await started(fetchFn);
    await turn(backend, 'read a');
    await turn(backend, 'and?');
    await turn(backend, 'and now?');
    const [read] = readsOf(requests.at(-1), 'a');
    expect(read).toContain('a200:');
    expect(read).not.toContain(READ_REFERENCE_HEADER);
  });

  it('moves the span past the XML result heading, so XML results become references too', async () => {
    await writeThreeFiles();
    const { fetchFn, requests } = scripted([
      xmlRead('a.txt'), xmlRead('b.txt'), xmlRead('c.txt'), reply('read all three'), reply('noted'), reply('done'),
    ]);
    const backend = await started(fetchFn, { toolProtocol: 'xml' });
    await turn(backend, 'read a, b and c');
    await turn(backend, 'anything else?');
    await turn(backend, 'look again');
    for (const file of ['a', 'b', 'c']) {
      const [reference] = readsOf(requests[5], file);
      expect(reference.startsWith('[Tool result: read_file]\n[host content receipt: ')).toBe(true);
      expect(reference).toContain(READ_REFERENCE_HEADER);
      expect(reference).not.toContain(`${file}200:`);
    }
  });

  it('stores the read metadata beside the messages, and a restored conversation projects its reads again', async () => {
    await writeThreeFiles();
    const first = scripted([nativeRead('r1', 'a.txt'), nativeRead('r2', 'b.txt'), nativeRead('r3', 'c.txt'), reply('read all three')]);
    const backend = await started(first.fetchFn);
    await turn(backend, 'read a, b and c');
    const snapshot = backend.snapshot();
    // The messages an older build would send carry none of it; the sidecar holds no excerpt and no cutoff.
    expect(JSON.stringify(snapshot.messages)).not.toMatch(/hostIdentity|historicalRead/);
    expect(JSON.stringify(snapshot.messages)).toContain('a200:');
    expect(JSON.stringify(snapshot.messages)).toContain('hostOutcome');
    const sidecar = snapshot.readProjection!;
    expect(sidecar.version).toBe(1);
    expect(sidecar.record.filter((entry) => entry.read)).toHaveLength(3);
    expect(JSON.stringify(sidecar)).not.toMatch(/excerpt|beforeTurnId|resultCharacters|a1:/);

    // Stored as workspace state stores it: through JSON.
    const later = scripted([reply('noted'), reply('done')]);
    const restored = new OpenAICompatBackend(makeConfig(), later.fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    expect(restored.restore(JSON.parse(JSON.stringify(snapshot)) as ConversationSnapshot)).toBe(true);
    await restored.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    // The first turn after the restore has the restored turn as its previous turn: its reads stay full.
    await turn(restored, 'anything else?');
    for (const file of ['a', 'b', 'c']) expect(readsOf(later.requests[0], file)[0]).toContain(`${file}200:`);
    // The next turn starts with the cutoff recomputed over the restored identities.
    await turn(restored, 'look again');
    for (const file of ['a', 'b', 'c']) {
      const [reference] = readsOf(later.requests[1], file);
      expect(reference).toContain(READ_REFERENCE_HEADER);
      expect(reference).not.toContain(`${file}200:`);
    }
    for (const body of later.requests) expect(JSON.stringify(body)).not.toMatch(/hostIdentity|historicalRead/);
    // A snapshot of the restored conversation carries the same metadata forward.
    expect(restored.snapshot().readProjection!.record.filter((entry) => entry.read)).toHaveLength(3);
  });
});

describe('the host relocates a read only where the payload is intact (v0.9.99 P1)', () => {
  const payload = 'p'.repeat(50);
  const output = `head\n${payload}\nfoot`;
  const fact = (): HistoricalReadFact => buildHistoricalReadFact({
    source: { kind: 'file', path: 'x.txt', representation: 'text' },
    rerun: { tool: 'read_file', args: { path: 'x.txt' } },
    resultText: output,
    span: { start: 5, end: 55 },
    truncated: false,
  })!;

  function appended(protocol: NativeToolProtocol | XmlToolProtocol, text: string, failureKind?: 'failed'): ChatMessage {
    const backend = new OpenAICompatBackend(makeConfig(), async () => { throw new Error('no request'); });
    (backend as any).currentProtocol = protocol;
    (backend as any).appendToolResult({ id: 'c1', name: 'read_file', args: { path: 'x.txt' } }, text, failureKind, { historicalRead: fact() });
    return (backend as any).history.at(-1);
  }

  it('keeps the span of a native result and of one the host appended a note to', () => {
    expect(appended(new NativeToolProtocol(), output).historicalRead?.span).toEqual({ start: 5, end: 55 });
    expect(appended(new NativeToolProtocol(), `${output}\n\nA host note.`).historicalRead?.span).toEqual({ start: 5, end: 55 });
  });

  it('moves the span past an XML result heading', () => {
    const message = appended(new XmlToolProtocol(), output);
    const heading = '[Tool result: read_file]\n'.length;
    expect(message.historicalRead?.span).toEqual({ start: 5 + heading, end: 55 + heading });
    expect(textOf(message).slice(5 + heading, 55 + heading)).toBe(payload);
  });

  it('drops the provenance when host text was put in front, when a bound cut the payload, or when the call failed', () => {
    expect(appended(new NativeToolProtocol(), `[A host prefix.]\n${output}`).historicalRead).toBeUndefined();
    expect(appended(new NativeToolProtocol(), `${output.slice(0, 30)}\n[Tool result truncated.]`).historicalRead).toBeUndefined();
    expect(appended(new NativeToolProtocol(), output, 'failed').historicalRead).toBeUndefined();
  });
});

describe('compaction plans over the view and keeps the original messages (v0.9.99 P1)', () => {
  it('summarizes references, not full reads, and keeps full reads and provenance in the kept tail', async () => {
    const resolved = resolveSmartCompactionPolicy({
      policy: bundledSmartCompactionPolicy(),
      agent: { roleTemplateKey: 'pm' },
      contextWindow: { tokens: 1_048_576, source: 'assumed' },
    });
    if (resolved.status !== 'resolved') throw new Error('bundled policy did not resolve');
    const payload = (turn: number) => Array.from({ length: 50 }, (_, line) => `t${turn}l${line}:${'字'.repeat(98)}`).join('\n');
    const history: ChatMessage[] = [{ role: 'system', content: 'Be terse.' }];
    for (let turn = 0; turn < 75; turn++) {
      const turnId = `t${turn}`;
      let at = 0;
      const id = () => ({ messageId: `${turnId}-${at++}`, turnId });
      history.push({ role: 'user', content: `task ${turn} `.padEnd(8_000, 'u'), hostIdentity: id() });
      if (turn === 5 || turn === 70) {
        const text = payload(turn);
        history.push({ role: 'assistant', content: null, hostIdentity: id(),
          tool_calls: [{ id: `r${turn}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `f${turn}.txt` }) } }] });
        history.push({ role: 'tool', tool_call_id: `r${turn}`, content: text, hostIdentity: id(), hostOutcome: { status: 'ok' },
          historicalRead: buildHistoricalReadFact({
            source: { kind: 'file', path: `f${turn}.txt`, representation: 'text' },
            rerun: { tool: 'read_file', args: { path: `f${turn}.txt` } },
            resultText: text, span: { start: 0, end: text.length }, truncated: false,
          }) });
      }
      history.push({ role: 'assistant', content: `done ${turn} `.padEnd(8_000, 'a'), hostIdentity: id() });
    }
    const backend = new OpenAICompatBackend(makeConfig({ allowedTools: [] }), async () => { throw new Error('no request'); });
    (backend as any).history = structuredClone(history);
    (backend as any).conversationRecord = structuredClone(history);
    (backend as any).readProjection = { version: 1, generation: 0, revision: 1, beforeTurnId: 't74' };
    const calls: ChunkedSummaryRequest[] = [];
    const host = { summarizeChunks: vi.fn(async (request: ChunkedSummaryRequest) => { calls.push(request); return { ok: true as const, summary: 'Earlier work.' }; }) };
    const request: ContextCompactionRequest = {
      operationId: 'op1', requestId: 'req1', agentId: 'a1', cause: 'automatic', policy: resolved.policy,
      before: { basis: 'unavailable' },
      pendingTurn: { instruction: 'Next.' },
      usage: { requestStarted: () => 'u', requestSettled: () => undefined },
      hostSummarizer: { summarizer: host as any, io: { chatCompletion: async () => ({ text: '' }) }, model: 'economy', contextWindow: 128_000 },
    };
    const result = await backend.contextControl.compact(request);
    expect(result.kind).toBe('compacted');
    const summarized = calls[0].records.map((record) => record.text).join('\n');
    expect(summarized).toContain(READ_REFERENCE_HEADER);
    expect(summarized).not.toContain('t5l49:');
    const kept: ChatMessage[] = (backend as any).history;
    const keptRead = kept.find((message) => message.tool_call_id === 'r70')!;
    expect(textOf(keptRead)).toContain('t70l49:');
    expect(keptRead.historicalRead).toEqual(history.find((message) => message.tool_call_id === 'r70')!.historicalRead);
    expect((backend as any).readProjection).toMatchObject({ generation: 1, revision: 2, beforeTurnId: 't74' });
  });
});

describe('reserved host fields are never taken from untrusted input (v0.9.99 P1)', () => {
  const longReply = '文'.repeat(50_000);
  const factOver = (text: string): HistoricalReadFact => buildHistoricalReadFact({
    source: { kind: 'file', path: 'forged.txt', representation: 'text' },
    rerun: { tool: 'read_file', args: { path: 'forged.txt' } },
    resultText: text, span: { start: 0, end: text.length }, truncated: false,
  })!;
  const errorsOf = (backend: OpenAICompatBackend): string[] => {
    const errors: string[] = [];
    backend.onEvent((event) => { if (event.kind === 'error') errors.push(event.message); });
    return errors;
  };

  it('drops malformed reserved fields from a provider reply, and the third turn still runs', async () => {
    const { fetchFn, requests } = scripted([
      { choices: [{ message: { role: 'assistant', content: 'one', historicalRead: {}, hostIdentity: { messageId: 'forged', turnId: 'forged' } } }] },
      reply('two'), reply('three'),
    ]);
    const backend = await started(fetchFn);
    const errors = errorsOf(backend);
    await turn(backend, 'first');
    await turn(backend, 'second');
    await turn(backend, 'third');
    expect(errors).toEqual([]);
    expect(requests).toHaveLength(3);
    const answer = ((backend as any).history as ChatMessage[]).find((message) => message.content === 'one')!;
    expect(answer.historicalRead).toBeUndefined();
    expect(answer.hostIdentity?.turnId).not.toBe('forged');
  });

  it('never turns a provider reply carrying a well-formed fact into a reference', async () => {
    const { fetchFn, requests } = scripted([
      { choices: [{ message: { role: 'assistant', content: longReply, historicalRead: factOver(longReply) } }] },
      reply('two'), reply('three'),
    ]);
    const backend = await started(fetchFn);
    await turn(backend, 'first');
    await turn(backend, 'second');
    await turn(backend, 'third');
    expect(JSON.stringify(requests[2].messages)).not.toContain(READ_REFERENCE_HEADER);
    expect(requests[2].messages.map(textOf)).toContain(longReply);
    expect(((backend as any).history as ChatMessage[]).some((message) => message.historicalRead)).toBe(false);
  });

  it('reads provenance only from tool results, even when an assistant message holds a host-shaped fact', async () => {
    const { fetchFn, requests } = scripted([reply('ok')]);
    const backend = await started(fetchFn);
    (backend as any).history.push(
      { role: 'user', content: 'old', hostIdentity: { messageId: 'x1', turnId: 'old1' } },
      { role: 'assistant', content: longReply, hostIdentity: { messageId: 'x2', turnId: 'old1' }, historicalRead: factOver(longReply) },
      { role: 'user', content: 'older', hostIdentity: { messageId: 'x3', turnId: 'old2' } },
      { role: 'assistant', content: 'fine', hostIdentity: { messageId: 'x4', turnId: 'old2' } },
    );
    await turn(backend, 'now');
    expect(requests[0].messages.map(textOf)).toContain(longReply);
  });

  it('drops reserved fields from restored messages, so a restored read stays full', async () => {
    const tool = (turnId: string, at: number): ChatMessage => ({
      role: 'tool', tool_call_id: `r${at}`, content: longReply, hostOutcome: { status: 'ok' },
      hostIdentity: { messageId: `s${at}`, turnId }, historicalRead: factOver(longReply),
    });
    const call = (turnId: string, at: number): ChatMessage => ({
      role: 'assistant', content: null, hostIdentity: { messageId: `c${at}`, turnId },
      tool_calls: [{ id: `r${at}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"forged.txt"}' } }],
    });
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'read it', hostIdentity: { messageId: 'u1', turnId: 's1' } },
      call('s1', 1), tool('s1', 1),
      { role: 'assistant', content: 'read', hostIdentity: { messageId: 'a1', turnId: 's1' } },
      { role: 'user', content: 'again', hostIdentity: { messageId: 'u2', turnId: 's2' } },
      { role: 'assistant', content: 'ok', hostIdentity: { messageId: 'a2', turnId: 's2' } },
    ];
    const later = scripted([reply('noted'), reply('done')]);
    const restored = new OpenAICompatBackend(makeConfig(), later.fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    expect(restored.restore({ version: 3, backend: 'openai-compat', hostTurnState: 'complete',
      completedMessageCount: messages.length, messages: structuredClone(messages) } as ConversationSnapshot)).toBe(true);
    await restored.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    await turn(restored, 'anything else?');
    await turn(restored, 'look again');
    expect(later.requests[1].messages.map(textOf)).toContain(longReply);
    const history: ChatMessage[] = (restored as any).history;
    expect(history.slice(0, messages.length).some((message) => message.hostIdentity || message.historicalRead)).toBe(false);
  });
});

describe('the snapshot sidecar in the backend (v0.9.99 P1)', () => {
  async function sessionWithReads(files = ['a', 'b', 'c']): Promise<ConversationSnapshot> {
    for (const name of files) await fs.writeFile(path.join(dir, `${name}.txt`), cjkFile(name), 'utf8');
    const first = scripted([...files.map((name, at) => nativeRead(`r${at + 1}`, `${name}.txt`)), reply('read them')]);
    const backend = await started(first.fetchFn);
    await turn(backend, 'read a, b and c');
    return JSON.parse(JSON.stringify(backend.snapshot()));
  }
  async function restoredFrom(snapshot: ConversationSnapshot, replies: Response[]) {
    const later = scripted(replies);
    const backend = new OpenAICompatBackend(makeConfig(), later.fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    expect(backend.restore(snapshot)).toBe(true);
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    return { backend, requests: later.requests };
  }

  it('keeps a read full when its stored message was changed after the snapshot was taken', async () => {
    // Four reads, so the three intact ones still save more than the threshold.
    const snapshot = await sessionWithReads(['a', 'b', 'c', 'd']);
    const messages = snapshot.messages as ChatMessage[];
    const edited = messages.find((message) => textOf(message).includes('a200:'))!;
    edited.content = textOf(edited).replace('a200:', 'A200:');
    const { backend, requests } = await restoredFrom(snapshot, [reply('noted'), reply('done')]);
    await turn(backend, 'anything else?');
    await turn(backend, 'look again');
    expect(readsOf(requests[1], 'a')[0]).toContain('A200:');
    for (const file of ['b', 'c', 'd']) expect(readsOf(requests[1], file)[0]).toContain(READ_REFERENCE_HEADER);
  });

  it('never stores read metadata in a quarantined tail', async () => {
    const snapshot = await sessionWithReads();
    // Only the first request counts as answered: the reads after it are left out as an unfinished tail.
    snapshot.completedMessageCount = 2;
    const { backend } = await restoredFrom(snapshot, []);
    const again = backend.snapshot();
    expect(again.quarantined?.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(again.quarantined)).not.toMatch(/hostIdentity|historicalRead/);
  });

  it('carries the metadata of a compacted provider history across a restore', async () => {
    const snapshot = await sessionWithReads();
    const { backend } = await restoredFrom(snapshot, []);
    const history: ChatMessage[] = (backend as any).history;
    // A rolling summary in front makes this a compacted provider history, which the snapshot stores separately.
    (backend as any).history = [history[0], { role: 'system', content: renderRollingSummary('Earlier work.') }, ...history.slice(1)];
    const compacted = JSON.parse(JSON.stringify(backend.snapshot())) as ConversationSnapshot;
    expect(compacted.providerHistory).toBeDefined();
    expect(compacted.readProjection!.provider!.filter((entry) => entry.read)).toHaveLength(3);
    const { backend: reloaded } = await restoredFrom(compacted, []);
    const reloadedHistory: ChatMessage[] = (reloaded as any).history;
    expect(reloadedHistory.filter((message) => message.historicalRead)).toHaveLength(3);
  });
});

describe('numeric diagnostics of the read projection (v0.9.99 P1)', () => {
  it('reports what the projection did to each request, and attributes history text by its host-recorded author', async () => {
    await writeThreeFiles();
    const { fetchFn } = scripted([
      nativeRead('r1', 'a.txt'), nativeRead('r2', 'b.txt'), nativeRead('r3', 'c.txt'), reply('read all three'),
      reply('noted'), reply('done'), reply('ok'),
    ]);
    const backend = await started(fetchFn);
    const measurements: Array<RequestComposition | undefined> = [];
    backend.onEvent((event) => { if (event.kind === 'request_composition') measurements.push(event.measurement); });
    await turn(backend, 'read a, b and c');
    await turn(backend, 'Async delegation result arrived. dev finished.', { turnOrigin: 'delegation-result' });
    await turn(backend, 'look again');
    await turn(backend, 'and now?');
    expect(measurements).toHaveLength(7);
    const first = measurements[0] as Extract<RequestComposition, { boundary: 'provider-attempt' }>;
    expect(first.read_projection).toEqual({ projection_revision: 0, watermark_index: 0, history_tool_results_referenced: 0,
      referenced_result_count: 0, new_eligible_savings_tokens: 0 });
    const third = measurements[5] as Extract<RequestComposition, { boundary: 'provider-attempt' }>;
    expect(third.read_projection).toMatchObject({ projection_revision: 1, referenced_result_count: 3 });
    expect(third.read_projection!.watermark_index).toBeGreaterThan(0);
    expect(third.read_projection!.history_tool_results_referenced).toBeGreaterThan(50_000);
    expect(third.read_projection!.new_eligible_savings_tokens).toBeGreaterThan(40_000);
    expect(third.history_text_by_source.user).toBeGreaterThan(0);
    expect(third.history_text_by_source['delegation-result']).toBeGreaterThan(0);
    expect(Object.values(third.history_text_by_source).reduce((a, b) => a + b, 0)).toBe(third.history_text);
    // The log line carries numbers only: no path, query or file text.
    const line = formatRequestComposition({ session: '12345678-1234-1234-1234-123456789abc', turn: 3, attempt: 1, route: 'openai-compatible' }, third);
    expect(line).toContain('"referenced_result_count":3');
    expect(line).not.toMatch(/a\.txt|a1:|文/);
  });
});
