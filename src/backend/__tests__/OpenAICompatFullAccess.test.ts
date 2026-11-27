import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { OpenAICompatBackend, type FetchFn } from '../OpenAICompatBackend';
import { AutonomyDefaultConsent, FULL_ACCESS_ACTION, resolveAutonomyPolicy } from '../../settings/AutonomyPolicy';
import type { AgentConfig } from '../../types';

it('Full access reaches the real engine and keeps Plan read only without confining permitted outside reads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-full-engine-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  const file = path.join(root, 'outside.ts');
  const source = 'const token = await getToken(req);';
  await fs.writeFile(file, source);
  const config: AgentConfig = { id: 'dev', name: 'Developer', role: 'developer', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, model: 'fake-public-model', systemPrompt: '',
    autoApprove: true, allowedTools: ['read', 'write'], workingDirectory: workspace };
  const values = new Map<string, unknown>([['history', 'newer irrelevant row'], ['run', 'ordinary']]);
  const consent = new AutonomyDefaultConsent({ get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key, value) => { values.set(key, value); } });
  const call = (id: string, name: string, args: object) => ({ choices: [{ message: { role: 'assistant', content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
  const reply = { choices: [{ message: { role: 'assistant', content: 'done' } }] };
  const responses = [call('read', 'read_file', { path: file }), call('plan-write', 'write_file', { path: file, content: 'must not land' }),
    reply, call('act-write', 'write_file', { path: file, content: 'allowed' }), reply];
  const requests: unknown[] = [];
  const fetchFn: FetchFn = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify(responses.shift() ?? reply) };
  };
  const backend = new OpenAICompatBackend(config, fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { fullFileAccess: () => resolveAutonomyPolicy({ config, backend: 'openai-compat', defaultMode: consent.effective('full-access'),
      trusted: true, commandMode: 'all', writeApproval: 'none' }).fullFileAccess, fullFileAccessRevision: () => consent.revision });
  try {
    await backend.start({ ROAM_API_KEY: 'public-test-key' });
    await consent.choose('full-access', { trusted: () => true, confirm: async () => FULL_ACCESS_ACTION, write: async () => {} });
    expect(requests).toHaveLength(0);
    const turn = (mode: 'plan' | 'act') => new Promise<void>((resolve) => {
      const off = backend.onEvent((event) => { if (event.kind === 'turn_complete') { off(); resolve(); } });
      backend.sendUserTurn('Read the named outside file, then propose the requested edit.', { mode });
    });
    await turn('plan');
    expect(JSON.stringify(requests)).toContain(source);
    expect(await fs.readFile(file, 'utf8')).toBe(source);
    await turn('act');
    expect(await fs.readFile(file, 'utf8')).toBe('allowed');
  } finally { await backend.stop(); await fs.rm(root, { recursive: true, force: true }); }
});
