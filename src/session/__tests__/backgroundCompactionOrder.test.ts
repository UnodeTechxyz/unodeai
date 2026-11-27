import { describe, expect, it } from 'vitest';
import { SessionManager } from '../SessionManager';
import { MessageBus } from '../../bus/MessageBus';
import { OpenAICompatBackend, type FetchFn, type StreamFetchFn } from '../../backend/OpenAICompatBackend';
import type { AgentConfig } from '../../types';

/**
 * v0.9.99 P6: a summary prepared beside a turn never goes out ahead of the turn's own provider request. With a real
 * OpenAI-compatible backend under the session, the foreground transport is invoked before the summary starts, on the
 * buffered and on the streaming transport.
 */
function config(): AgentConfig {
  return {
    id: 'dev', name: 'dev', role: 'senior-dev', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-chat', systemPrompt: '', autoApprove: true, allowedTools: [], workingDirectory: process.cwd(),
  };
}

async function order(transport: 'buffered' | 'streaming'): Promise<string[]> {
  const events: string[] = [];
  const reply = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
  const fetchFn: FetchFn = async () => {
    events.push('foreground transport');
    return { ok: true, status: 200, text: async () => reply };
  };
  const streamFetchFn: StreamFetchFn = async () => {
    events.push('foreground transport');
    const encoder = new TextEncoder();
    return { ok: true, status: 200, body: (async function* () {
      yield encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' } }] })}\n\n`);
      yield encoder.encode('data: [DONE]\n\n');
    })() };
  };
  const bus = new MessageBus();
  let backend!: OpenAICompatBackend;
  const mgr = new SessionManager(5, bus, {
    createBackend: (agent: AgentConfig) => {
      backend = new OpenAICompatBackend(agent, fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 }, undefined,
        transport === 'streaming' ? streamFetchFn : undefined);
      return backend;
    },
    resolveEnv: async () => ({ ROAM_API_KEY: 'sk-test' }),
    compaction: {
      run: async () => ({ kind: 'not-needed', reason: 'below-trigger' }),
      // A due request that fits: send now, and start the summary when the session says so.
      gate: async () => ({ outcomes: [], startBackground: () => { events.push('summary start'); } }),
      cancelBackground: async () => undefined,
    },
  } as any);
  mgr.create(config());
  await mgr.start('dev', { pin: 'take' });
  const finished = new Promise<void>((resolve) => mgr.on('session.statusChanged', () => {
    if (mgr.get('dev')?.status === 'idle' && events.includes('foreground transport')) resolve();
  }));
  bus.send('user', 'dev', 'task.assign', { instruction: 'go' });
  await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  await mgr.stop('dev');
  return events;
}

describe('background summary start order (v0.9.99 P6)', () => {
  it('invokes the turn\'s buffered transport before the summary starts', async () => {
    expect(await order('buffered')).toEqual(['foreground transport', 'summary start']);
  });

  it('invokes the turn\'s streaming transport before the summary starts', async () => {
    expect(await order('streaming')).toEqual(['foreground transport', 'summary start']);
  });
});
