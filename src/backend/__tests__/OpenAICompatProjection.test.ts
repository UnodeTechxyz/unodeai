import { describe, expect, it } from 'vitest';
import { OpenAICompatBackend, type ChatMessage, type FetchFn } from '../OpenAICompatBackend';
import { estimateTokens, TokenCounter } from '../TokenCounter';
import type { BackendEvent, TurnAttachments } from '../AgentBackend';
import type { AgentConfig } from '../../types';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'a1',
    name: 'Worker',
    role: 'senior-dev',
    skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-chat',
    systemPrompt: 'Be terse.',
    autoApprove: true,
    allowedTools: ['read'],
    workingDirectory: process.cwd(),
    ...overrides,
  };
}

function scriptedFetch(): { fetchFn: FetchFn; requests: any[] } {
  const requests: any[] = [];
  const fetchFn: FetchFn = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: `reply ${requests.length}` } }] }) };
  };
  return { fetchFn, requests };
}

function backendWith(fetchFn: FetchFn, config = makeConfig()): OpenAICompatBackend {
  return new OpenAICompatBackend(config, fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
}

async function turn(backend: OpenAICompatBackend, instruction: string, attachments?: TurnAttachments): Promise<void> {
  await new Promise<void>((resolve) => {
    const off = backend.onEvent((event) => {
      if (event.kind === 'turn_complete') { off?.(); resolve(); }
    });
    backend.sendUserTurn(instruction, attachments);
  });
}

/** The context guard's estimate of one request body, as the projection defines it. */
function requestEstimate(body: { messages: ChatMessage[]; tools?: unknown }): number {
  return new TokenCounter().estimateMessages(body.messages) + (body.tools ? estimateTokens(JSON.stringify(body.tools)) : 0);
}

describe('OpenAI-compatible next-turn projection (v0.9.90)', () => {
  it('projects exactly the request the next turn sends, with its instruction and context', async () => {
    const { fetchFn, requests } = scriptedFetch();
    const backend = backendWith(fetchFn);
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    await turn(backend, 'first task');
    const attachments: TurnAttachments = { projectContext: 'Project rules: keep answers short.', workspaceContext: 'src/ has 3 files.' };
    const projection = backend.contextControl.projectNextTurn('second task, with more detail than the first', attachments);
    await turn(backend, 'second task, with more detail than the first', attachments);
    expect(requests).toHaveLength(2);
    expect(requests[1].tools?.length).toBeGreaterThan(0);
    expect(projection).toEqual({
      tokens: requestEstimate(requests[1]),
      basis: 'host-estimated',
      window: 1_048_576,
      windowSource: 'assumed',
    });
  });

  it('sends, repairs, latches and emits nothing while projecting', async () => {
    const { fetchFn, requests } = scriptedFetch();
    const backend = backendWith(fetchFn);
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    await turn(backend, 'first task');
    // An unanswered tool call is repaired only when a real request is built.
    (backend as any).history.push({ role: 'assistant', content: null, tool_calls: [{ id: 'orphan', type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
    const before = JSON.stringify({
      history: (backend as any).history,
      record: (backend as any).conversationRecord,
      estimate: (backend as any).pendingRequestEstimate,
      shape: (backend as any).pendingRequestShape,
      prefix: (backend as any).prefixFingerprint,
    });
    const events: BackendEvent[] = [];
    backend.onEvent((event) => events.push(event));
    backend.contextControl.projectNextTurn('next', { projectContext: 'rules' });
    expect(JSON.stringify({
      history: (backend as any).history,
      record: (backend as any).conversationRecord,
      estimate: (backend as any).pendingRequestEstimate,
      shape: (backend as any).pendingRequestShape,
      prefix: (backend as any).prefixFingerprint,
    })).toBe(before);
    expect(events).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('grows with the pending instruction and uses a configured window', () => {
    const backend = backendWith(scriptedFetch().fetchFn, makeConfig({ contextWindowTokens: 128_000 }));
    const small = backend.contextControl.projectNextTurn('short') as { tokens: number; window: number; windowSource: string };
    const large = backend.contextControl.projectNextTurn('x'.repeat(40_000)) as { tokens: number };
    expect(large.tokens - small.tokens).toBeGreaterThanOrEqual(9_990);
    expect(small).toMatchObject({ window: 128_000, windowSource: 'configured' });
  });
});
