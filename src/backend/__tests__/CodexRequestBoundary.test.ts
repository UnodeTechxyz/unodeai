import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../../types';
import { CODEX_CLI_DEFAULT_MODEL, CodexBackend, type CodexBackendDeps } from '../CodexBackend';
import { REQUEST_LIMIT_STOPPED_REFUSAL, type RequestBoundary, type RequestBoundaryDetail, type RequestBoundaryOutcome } from '../requestBoundary';
import { fixedCodexProgram } from './codexProgramFixture';

/* v0.9.94: the request limit boundary on the Codex CLI route. Codex makes its own model requests and runs its
   native tools itself, so the boundary is asked for the calls the host serves: the dynamic tools. */

function config(): AgentConfig {
  return {
    id: 'codex-1', name: 'Codex PM', role: 'pm', skill: '',
    provider: { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' }, model: CODEX_CLI_DEFAULT_MODEL,
    systemPrompt: 'Coordinate.', autoApprove: true, allowedTools: ['read', 'write', 'execute'], backend: 'codex',
    workingDirectory: process.cwd(),
  };
}

interface Asked {
  kind: string;
  detail?: RequestBoundaryDetail;
  answer(outcome: RequestBoundaryOutcome): void;
}

function heldBoundary(log: string[]) {
  const asked: Asked[] = [];
  const boundary: RequestBoundary = (kind, detail) => new Promise((resolve) => {
    log.push(`boundary:${kind}:${detail?.tool ?? ''}`);
    asked.push({ kind, detail, answer: resolve });
  });
  return { boundary, asked };
}

async function seen<T>(promise: Promise<T>): Promise<T | 'held'> {
  return Promise.race([promise, new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), 0))]);
}

/** A backend inside a running turn, with the host tools a coordinator is served. Nothing is spawned. */
function inTurn(log: string[], deps: Partial<CodexBackendDeps> = {}, attachments?: Record<string, unknown>) {
  const teamTools = ['dispatch_task', 'list_agents', 'collect_ready_tasks', 'close_assignment', 'record_task_disposition', 'run_checks'];
  const backend = new CodexBackend(config(), undefined, {
    launchProgram: fixedCodexProgram('C:/tools/codex.exe'),
    access: () => ({ trusted: true, restricted: false, readRoots: [process.cwd()], writeRoots: [process.cwd()] }),
    teamMcpBridge: {
      async listTools() { return teamTools.map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })); },
      async callToolOutcome(name: string) {
        log.push(`team:${name}`);
        return { source: 'host', contentSource: 'host', status: 'success', output: `${name} ran` };
      },
    } as any,
    mcp: {
      hub: {
        getToolSpecs: () => [{ type: 'function', function: { name: 'docs__lookup', description: 'Look up.', parameters: { type: 'object', properties: {} } } }],
        async executeTool(name: string) {
          log.push(`integration:${name}`);
          return { source: 'host', contentSource: 'mixed-external', status: 'success', output: 'documentation' };
        },
      },
      grants: [{ serverId: 'docs', toolFilter: 'all' }],
    } as any,
    executableSkills: {
      toolSpec: () => ({ type: 'function', function: { name: 'run_skill_action', description: 'Action.', parameters: { type: 'object', properties: {} } } }),
      async run() {
        log.push('skill:run_skill_action');
        return { source: 'host', contentSource: 'host', status: 'success', output: 'approved receipt' };
      },
    } as any,
    ...deps,
  });
  const internals = backend as any;
  internals.threadId = 'thread-1';
  internals.turnId = 'turn-1';
  internals.managedToolAbortController = new AbortController();
  internals.activeAttachments = attachments;
  const events: any[] = [];
  backend.onEvent((event) => events.push(event));
  let sequence = 0;
  const call = (tool: string, args: Record<string, unknown> = {}): Promise<{ success: boolean; contentItems: Array<{ text: string }> }> =>
    internals.dynamicToolCall({ threadId: 'thread-1', turnId: 'turn-1', callId: `call-${++sequence}`, namespace: null, tool, arguments: args });
  return { backend, events, call };
}

describe('Codex request boundary before a host-served call', () => {
  for (const [tool, ran, output] of [
    ['docs__lookup', 'integration:docs__lookup', 'documentation'],
    ['run_skill_action', 'skill:run_skill_action', 'approved receipt'],
    ['dispatch_task', 'team:dispatch_task', 'dispatch_task ran'],
    ['run_checks', 'team:run_checks', 'run_checks ran'],
  ] as const) {
    it(`asks before ${tool} runs, and runs it only after the answer`, async () => {
      const log: string[] = [];
      const { boundary, asked } = heldBoundary(log);
      const { events, call } = inTurn(log, { requestBoundary: boundary });
      const running = call(tool);
      expect(await seen(running)).toBe('held');
      expect(log).toEqual([`boundary:effect:${tool}`]);
      expect(events.some((event) => event.kind === 'tool_result')).toBe(false);

      asked[0].answer('proceed');
      expect(await running).toEqual({ success: true, contentItems: [{ type: 'inputText', text: output }] });
      expect(log).toEqual([`boundary:effect:${tool}`, ran]);
    });

    it(`refuses ${tool} with the typed safety-limit refusal after Stop, and it does not run`, async () => {
      const log: string[] = [];
      const { events, call } = inTurn(log, { requestBoundary: async () => 'stopped' });
      expect(await call(tool)).toEqual({ success: false, contentItems: [{ type: 'inputText', text: REQUEST_LIMIT_STOPPED_REFUSAL }] });
      expect(log).toEqual([]);
      expect(events.find((event) => event.kind === 'tool_result')?.outcome)
        .toEqual({ status: 'refused', observedBy: 'host', reason: 'safety-limit' });
    });
  }

  it('never asks for the coordinator\'s read or for the team tools that read, record or close out', async () => {
    const log: string[] = [];
    const asked: string[] = [];
    const { call } = inTurn(log, { requestBoundary: async (_kind, detail) => { asked.push(detail?.tool ?? ''); return 'stopped'; } });
    for (const [tool, args] of [
      ['list_agents', {}],
      ['collect_ready_tasks', {}],
      ['close_assignment', { outcome: 'blocked', summary: 's' }],
      ['record_task_disposition', { handle: 'h', disposition: 'accepted' }],
    ] as const) {
      expect((await call(tool, args)).success, tool).toBe(true);
    }
    // The host read runs through the workspace tools; a missing file is a failed read, never a limit refusal.
    const read = await call('read_file', { path: 'no-such-file-for-the-boundary-test.txt' });
    expect(read.contentItems[0].text).not.toContain(REQUEST_LIMIT_STOPPED_REFUSAL);
    expect(asked).toEqual([]);

    // A decision that sends the teammate a message is held like a dispatch.
    expect((await call('record_task_disposition', { handle: 'h', disposition: 'needs-rework', reason: 'r' })).success).toBe(false);
    expect(asked).toEqual(['record_task_disposition']);
    expect(log).toEqual(['team:list_agents', 'team:collect_ready_tasks', 'team:close_assignment', 'team:record_task_disposition']);
  });

  it('releases a held call as stopped when the turn is interrupted', async () => {
    const log: string[] = [];
    const { boundary, asked } = heldBoundary(log);
    const { backend, call } = inTurn(log, { requestBoundary: boundary });
    const running = call('docs__lookup');
    expect(await seen(running)).toBe('held');
    expect(asked[0].detail?.signal?.aborted).toBe(false);
    backend.abort();
    expect(await running).toEqual({ success: false, contentItems: [{ type: 'inputText', text: REQUEST_LIMIT_STOPPED_REFUSAL }] });
    expect(asked[0].detail?.signal?.aborted).toBe(true);
    asked[0].answer('proceed');
    await seen(Promise.resolve());
    expect(log).toEqual(['boundary:effect:docs__lookup']);
  });

  it('keeps the Plan mode refusal ahead of the limit', async () => {
    const log: string[] = [];
    const asked: string[] = [];
    const { call } = inTurn(log, { requestBoundary: async (_kind, detail) => { asked.push(detail?.tool ?? ''); return 'stopped'; } }, { mode: 'plan' });
    const refused = await call('docs__lookup');
    expect(refused.success).toBe(false);
    expect(refused.contentItems[0].text).toMatch(/unavailable in Plan mode/);
    expect(asked).toEqual([]);
  });

  it('changes nothing when no boundary is injected', async () => {
    const log: string[] = [];
    const { call } = inTurn(log);
    expect((await call('docs__lookup')).success).toBe(true);
    expect((await call('run_skill_action')).success).toBe(true);
    expect((await call('dispatch_task')).success).toBe(true);
    expect(log).toEqual(['integration:docs__lookup', 'skill:run_skill_action', 'team:dispatch_task']);
  });
});
