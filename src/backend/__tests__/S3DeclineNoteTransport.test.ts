import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamTools, type TeamView } from '../TeamTools';
import { MessageBus } from '../../bus/MessageBus';
import { CommandPolicy } from '../CommandPolicy';
import { OpenAICompatBackend, type FetchFn } from '../OpenAICompatBackend';
import { modelFacingToolOutput, summarizeToolResult } from '../toolSummary';
import { asProvider, directPreparer } from './shellFixtures';
import { FileWritePolicy } from '../fileWritePolicy';
import { notStartedBy } from '../CommandExecution';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';
import type { AgentConfig } from '../../types';

afterEach(removeTemporaryFolders);
const note = 'Use the dev instead; keep "production" unchanged.\nExplain the trade-off.';
const view: TeamView = { list: () => [], resolve: () => undefined };

describe('human decline notes at the actual model transport', () => {
  it('TeamTools keeps a quoted note on its text adapter and a clean display on its structured outcome', async () => {
    const execute = vi.fn(async () => ({ code: 0, output: 'must not run' }));
    const team = new TeamTools('pm', view, new MessageBus(), { cwd: process.cwd(), verifyCommand: 'npm test',
      commandPolicy: new CommandPolicy('ask'), requestApproval: async () => ({ allow: false, note }),
      prepareCommand: directPreparer(execute) });
    const text = await team.run('run_checks', {});
    expect(text).toContain(`The user said: ${JSON.stringify(note)}`);
    const outcome = await team.runOutcome('run_checks', {});
    expect(outcome).toMatchObject({ status: 'refused', reason: 'consent', userNote: note });
    expect(outcome.output).not.toContain('Use the dev');
    expect(modelFacingToolOutput(outcome)).toContain(`The user said: ${JSON.stringify(note)}`);
    expect(JSON.stringify(summarizeToolResult('run_checks', {}, outcome))).not.toContain('Use the dev');
    expect(execute).not.toHaveBeenCalled();
  });

  it('TeamTools never attributes a host expiry to the user', async () => {
    const team = new TeamTools('pm', view, new MessageBus(), { cwd: process.cwd(), verifyCommand: 'npm test',
      commandPolicy: new CommandPolicy('ask'), requestApproval: async () => ({ allow: false, note: 'host deadline expired', noteOrigin: 'host' }),
      prepareCommand: directPreparer(async () => { throw new Error('must not run'); }) });
    const outcome = await team.runOutcome('run_checks', {});
    expect(outcome).toMatchObject({ status: 'refused', reason: 'consent' });
    expect('userNote' in outcome).toBe(false);
    expect(modelFacingToolOutput(outcome)).not.toContain('The user said:');
  });

  it('TeamTools revalidates a prepared check after approval and preserves a policy refusal', async () => {
    const policy = new CommandPolicy('all'); const execute = vi.fn();
    const base = directPreparer(async () => ({ code: 0, output: 'not used' }));
    const team = new TeamTools('pm', view, new MessageBus(), { cwd: process.cwd(), verifyCommand: 'npm test', commandPolicy: policy,
      prepareCommand: () => {
        const prepared = base(); if (!prepared.ok) return prepared;
        return { ...prepared, execute: async (_command, options) => {
          policy.reload('none', []);
          const refusal = await options.beforeEffect?.();
          if (refusal) return notStartedBy(refusal);
          execute(); return { status: 'exited' as const, code: 0, output: 'must not run' };
        } };
      } });
    expect(await team.runOutcome('run_checks', {})).toMatchObject({ status: 'refused', reason: 'capability' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([false, true])('run_checks binds its disclosed unknown action to folder identity (replacement=%s)', async replacement => {
    for (let repeat = 0; repeat < 25; repeat++) {
      const root = await fs.realpath(await temporaryFolder('unode-team-outward-binding-'));
      const cwd = `${root}/work`; await fs.mkdir(cwd);
      const execute = vi.fn(async () => ({ code: 0, output: 'fixture only; no outward program ran' }));
      const approve = vi.fn(async () => {
        if (replacement) { await fs.rename(cwd, `${root}/old-work`); await fs.mkdir(cwd); }
        else await fs.writeFile(`${cwd}/changed-source.txt`, 'Source contents can change under an unknown-effects approval.');
        return { allow: true };
      });
      const team = new TeamTools('pm', view, new MessageBus(), { cwd, verifyCommand: 'gh pr create --fill',
        commandPolicy: new CommandPolicy('all'), requestApproval: approve, prepareCommand: directPreparer(execute) });
      const result = await team.runOutcome('run_checks', {});
      expect(approve).toHaveBeenCalledTimes(1);
      if (replacement) {
        expect(result).toMatchObject({ status: 'refused', reason: 'safety-limit' });
        expect(execute).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ status: 'success' });
        expect(execute).toHaveBeenCalledTimes(1);
      }
    }
  });

  it.each(['npm test', 'gh pr create --fill', 'protected settings write'])('the next actual HTTP request carries the declined %s note, while its tool card stays clean', async command => {
    const root = await fs.realpath(await temporaryFolder('unode-s3-note-transport-'));
    const security = command === 'protected settings write';
    const settings = `${root}/settings.json`, original = '{"unode.commandApproval":"ask"}';
    if (security) await fs.writeFile(settings, original);
    const denyWrite = vi.fn(async () => ({ action: 'deny' as const, userNote: note }));
    const writes = new FileWritePolicy({ workspaceId: () => root,
      securityControls: () => [{ kind: 'user-settings', path: settings }] }).forAgent({ agentId: 'dev', decide: denyWrite });
    const sent: any[] = []; const events: any[] = [];
    const responses = [
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-note', type: 'function',
        function: { name: security ? 'write_file' : 'run_command', arguments: JSON.stringify(security
          ? { path: settings, content: '{"unode.commandApproval":"all"}' } : { command }) } }] } }] },
      { choices: [{ message: { role: 'assistant', content: 'I will adjust the work.' } }] },
    ];
    const fetch: FetchFn = async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return { ok: true, status: 200, text: async () => JSON.stringify(responses.shift() ?? responses[0]) };
    };
    const execute = vi.fn(async () => { throw new Error('a declined command cannot run'); });
    const approve = vi.fn(async () => ({ allow: false, note, noteOrigin: 'human' as const }));
    const config: AgentConfig = { id: 'dev', name: 'Fixture Dev', role: 'developer', skill: '', systemPrompt: '',
      provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, model: 'public-fixture-model',
      workingDirectory: root, allowedTools: security ? ['read', 'write'] : ['execute'], autoApprove: true };
    const backend = new OpenAICompatBackend(config, fetch, undefined, undefined,
      new CommandPolicy(command === 'npm test' ? 'ask' : 'all'), { retryBaseMs: 0 },
      undefined, undefined, approve, undefined, undefined, asProvider(execute), undefined, undefined, undefined, undefined,
      { fileWrites: writes });
    try {
      backend.onEvent(event => events.push(event));
      await backend.start({ ROAM_API_KEY: 'public-fixture-only' });
      await new Promise<void>(resolve => {
        const off = backend.onEvent(event => { if (event.kind === 'turn_complete') { off(); resolve(); } });
        backend.sendUserTurn('Run the requested command and respect my decision.');
      });
      expect(security ? denyWrite : approve).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      expect(sent).toHaveLength(2);
      const result = sent[1].messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'call-note');
      expect(result?.content).toContain(`The user said: ${JSON.stringify(note)}`);
      const card = events.find(event => event.kind === 'tool_result' && event.name === (security ? 'write_file' : 'run_command'));
      expect(card?.outcome).toMatchObject({ status: 'refused', reason: 'consent' });
      expect(JSON.stringify(card)).not.toContain('Use the dev');
      expect(events.filter(event => event.kind === 'log').some(event => JSON.stringify(event).includes('Use the dev'))).toBe(false);
      if (security) expect(await fs.readFile(settings, 'utf8')).toBe(original);
    } finally { await backend.stop(); }
  });
});
