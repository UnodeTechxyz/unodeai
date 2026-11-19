/*
 * v0.9.101 A2/F1 (design §4.4, §12 F1, T101-2): a refused outside write blocks only that step. Until v0.9.100 the
 * OpenAI-compatible tool loop ended the turn on it with a fixed reply that also said to open the folder in a new
 * window and send the task again. Through the production loop with a scripted model: the batch's other results reach
 * the model and its next step runs; the refused target is offered through the request's one access state; the
 * document draft is kept; Grant access on the request's item (the real access owner) lets the same turn save it.
 * Real temp folders, the real WorkspaceTools, the real access owner and offer, and the real isolated render worker;
 * only the model (fetch) and the native picker (choose) are scripted.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackendEvent, TurnAttachments } from '../AgentBackend';
import type { EngineOptions } from '../Diagnostics';
import { SessionLocalReadScopeConsent, type SessionPathAccessGrant } from '../localReadScope';
import { OpenAICompatBackend, type FetchFn } from '../OpenAICompatBackend';
import { createPathAccessOffer, type PathAccessItem } from '../../host/PathAccessOffer';
import type { AgentConfig } from '../../types';
import { documentRouteRenderer } from './documentRouteFixtures';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';

afterEach(removeTemporaryFolders);
// The first test starts the real isolated render worker; give it room when the machine is busy.
vi.setConfig({ testTimeout: 60_000 });

const NEW_WINDOW_ROUTE = /new window|another window|as the workspace|send the request again|send your request again|resend/i;

const config = (workingDirectory: string, allowedTools: AgentConfig['allowedTools'] = ['read', 'write']): AgentConfig => ({
  id: 'a1', name: 'Worker', role: 'senior-dev', skill: '', provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
  model: 'deepseek-chat', systemPrompt: 'Be terse.', autoApprove: true, allowedTools, workingDirectory,
});
const call = (id: string, name: string, args: object) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const step = (...calls: ReturnType<typeof call>[]) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }] });
const answer = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }] });

/** The model: scripted replies in order, each request recorded; `before[n]` runs while request n is in flight. */
function scriptedModel(bodies: unknown[], before: Record<number, () => Promise<void>> = {}) {
  const requests: any[] = [];
  const fetchFn: FetchFn = async (_url, init) => {
    const n = requests.length;
    requests.push(JSON.parse(init.body));
    await before[n]?.();
    return { ok: true, status: 200, text: async () => JSON.stringify(bodies[Math.min(n, bodies.length - 1)]) };
  };
  return { fetchFn, requests };
}

async function runTurn(backend: OpenAICompatBackend, instruction: string, attachments?: TurnAttachments): Promise<BackendEvent[]> {
  const events: BackendEvent[] = [];
  const done = new Promise<void>((resolve) => backend.onEvent((event) => {
    events.push(event);
    if (event.kind === 'turn_complete') resolve();
  }));
  await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
  backend.sendUserTurn(instruction, attachments);
  await done;
  return events;
}

/**
 * The production wiring of one agent's outside paths, as extension.ts gives it: the access owner's live grants, the
 * offer each refused file tool feeds, and on a grant the session's notice steered into the running turn. The toast
 * is not answered; the person uses the request's item.
 */
function accessHost(engine: Omit<EngineOptions, 'livePathAccess' | 'onFileOutsideRoot'> = {}) {
  const owner = new SessionLocalReadScopeConsent(async () => false);
  const items: PathAccessItem[] = [];
  const presented: string[] = [];
  const grants: SessionPathAccessGrant[] = [];
  let backend: OpenAICompatBackend | undefined;
  let settle: () => void = () => {};
  const offer = createPathAccessOffer({
    owner,
    canOffer: () => true,
    captureRequest: () => ({ requestId: 'r1', isCurrent: () => true }),
    present: async (named) => { presented.push(named); return false; },
    choose: async () => ({ permission: 'readwrite', lifetime: 'session' }),
    granted: (grant) => {
      grants.push(grant);
      void backend?.steerNotice('Host scope update: Read + Write access for a requested file or folder is now available for '
        + 'this session. Your next matching file-tool call can use it. This changes no command permission and replays no previous call.');
      settle();
    },
    unavailable: () => {},
    requestEnded: () => {},
    item: (item) => { items.push(item); },
  });
  const make = (workspace: string, fetchFn: FetchFn, allowedTools?: AgentConfig['allowedTools']) => {
    backend = new OpenAICompatBackend(config(workspace, allowedTools), fetchFn, undefined, undefined, undefined, { noProgressBackoffMs: 0 },
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => false, undefined, undefined,
      { ...engine, livePathAccess: () => owner.pathAccessFor('r1'), onFileOutsideRoot: (target) => offer(target) });
    return backend;
  };
  /** Grant access on the request's latest item for a target, as the chat item's button does. */
  const grantFromItem = async (target: string) => {
    const item = [...items].reverse().find((entry) => entry.target === target);
    if (!item) throw new Error(`no access item for ${target}`);
    const granted = new Promise<void>((resolve) => { settle = resolve; });
    item.grant();
    await granted;
  };
  return { owner, items, presented, grants, make, grantFromItem };
}

/** The host's results for one tool, in call order (the host gives each call its own id). */
const results = (events: BackendEvent[], name: string) => events.filter((event): event is Extract<BackendEvent, { kind: 'tool_result' }> =>
  event.kind === 'tool_result' && event.name === name);
/** A message's text, a cache-marked message's text parts included. */
const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('') : '';
const toolMessage = (request: any, id: string): string =>
  textOf(request.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === id)?.content);
/** Every text the model was sent in these requests. */
const modelFacingText = (requests: any[]): string =>
  requests.flatMap((request) => request.messages).map((message: any) => textOf(message.content)).join('\n');

describe('v0.9.101 A2/F1: a refused outside write blocks only that step', () => {
  it('the batch\'s other results reach the model, its next step runs, the draft is kept, and after Grant access on the request\'s item the same turn saves it', async () => {
    const workspace = await temporaryFolder('unode-a2-workspace-');
    const outside = await temporaryFolder('unode-a2-outside-');
    await fs.writeFile(path.join(workspace, 'source.md'), 'SOURCE-TEXT lease terms', 'utf8');
    const target = path.join(outside, 'summary.docx');
    const real = await documentRouteRenderer();
    const renderer = { render: vi.fn((...args: Parameters<typeof real.render>) => real.render(...args)) };
    const host = accessHost({ documentRenderer: renderer });
    const part = (blocks: object[], final = false) => ({ schema_version: 1, path: target, format: 'docx', template: 'report-v1',
      draft: 'summary', ...(final ? { final: true } : {}), document: { title: 'Lease Summary', language: 'en', blocks } });
    const paragraph = (text: string) => ({ type: 'paragraph', content: [{ text }] });
    const model = scriptedModel([
      // The first part of the draft: kept, and the missing save condition is named (G4).
      step(call('c-part', 'write_document', part([paragraph('PART-ONE from the lease')]))),
      // One batch: the final save is refused, the read and the workspace write are permitted.
      step(call('c-save', 'write_document', part([paragraph('PART-TWO fees')], true)),
        call('c-read', 'read_file', { path: 'source.md' }),
        call('c-notes', 'write_file', { path: 'notes.md', content: 'NOTES from the source' })),
      // The model's next, independent step.
      step(call('c-analysis', 'write_file', { path: 'analysis.md', content: 'ANALYSIS of the terms' })),
      // After the grant reached it: the kept draft is saved, no parts sent again.
      step(call('c-save-again', 'write_document', part([], true))),
      answer('Saved the summary; notes and analysis are in the workspace.'),
    ], {
      // While the model works on its next step, the person chooses Grant access on the request's item.
      2: () => host.grantFromItem(target),
    });
    const backend = host.make(workspace, model.fetchFn);
    const events = await runTurn(backend, `Summarise source.md and save it to ${target}.`);

    // The refusal is one tool result; the turn went on to the model's next step (before: the turn ended there).
    expect(results(events, 'write_document').map((event) => event.outcome.status)).toEqual(['success', 'refused', 'success']);
    expect(results(events, 'write_document')[1].outcome).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    expect(model.requests).toHaveLength(5);
    // Every result of the batch reached the model: the refusal, the read and the workspace write.
    const afterBatch = model.requests[2];
    expect(toolMessage(afterBatch, 'c-save')).toContain('Continue with the work that does not need it.');
    expect(toolMessage(afterBatch, 'c-save')).toContain('The document draft is kept with every part');
    expect(toolMessage(afterBatch, 'c-read')).toContain('SOURCE-TEXT lease terms');
    expect(toolMessage(afterBatch, 'c-notes')).toMatch(/^Wrote /);
    expect(await fs.readFile(path.join(workspace, 'notes.md'), 'utf8')).toBe('NOTES from the source');
    // The next step ran in the same turn.
    expect(await fs.readFile(path.join(workspace, 'analysis.md'), 'utf8')).toBe('ANALYSIS of the terms');
    // The refusals fed the request's one access state for that target: one notice, one item, not granted yet at first.
    expect(host.presented).toEqual([target]);
    expect(host.items[0]).toMatchObject({ requestId: 'r1', target, label: 'File summary.docx', state: 'needs-access' });
    expect(new Set(host.items.map((item) => item.id)).size).toBe(1);
    expect(host.items.at(-1)).toMatchObject({ state: 'granted', held: 'readwrite' });
    expect(host.grants).toHaveLength(1);
    // The grant was told to this turn, and the kept draft was then saved once, with both parts, none sent again.
    expect(modelFacingText([model.requests[3]])).toContain('[UnodeAi] Host scope update');
    expect(modelFacingText([model.requests[2]])).not.toContain('[UnodeAi] Host scope update');
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(JSON.stringify(renderer.render.mock.calls[0])).toContain('PART-ONE from the lease');
    expect(JSON.stringify(renderer.render.mock.calls[0])).toContain('PART-TWO fees');
    expect(await fs.readdir(outside)).toEqual(['summary.docx']);
    expect((events.find((event) => event.kind === 'turn_complete') as any).result.text)
      .toBe('Saved the summary; notes and analysis are in the workspace.');
    // Nothing the model or the person was given points to another window, another workspace or a second request.
    expect(modelFacingText(model.requests)).not.toMatch(NEW_WINDOW_ROUTE);
    for (const event of events) {
      if (event.kind === 'assistant' || event.kind === 'runtime_notice') expect(event.text).not.toMatch(NEW_WINDOW_ROUTE);
    }
  });

  it('a call refused twice before the grant runs again after it: the repeat breaker counts afresh from the grant', async () => {
    const workspace = await temporaryFolder('unode-a2-repeat-workspace-');
    const outside = await temporaryFolder('unode-a2-repeat-outside-');
    const target = path.join(outside, 'out.txt');
    const host = accessHost();
    const write = () => step(call(`w-${Math.random()}`, 'write_file', { path: target, content: 'SAVED' }));
    const model = scriptedModel([
      write(), write(),
      step(call('read-ws', 'list_dir', { path: '.' })),
      write(),
      answer('Saved after the grant.'),
    ], { 2: () => host.grantFromItem(target) });
    const backend = host.make(workspace, model.fetchFn);
    const events = await runTurn(backend, `Write ${target}.`);

    expect(results(events, 'write_file').map((event) => event.outcome.status)).toEqual(['refused', 'refused', 'success']);
    expect(events.some((event) => event.kind === 'tool_result' && event.summary === 'blocked: repeated failing call')).toBe(false);
    expect(await fs.readFile(target, 'utf8')).toBe('SAVED');
    expect((events.find((event) => event.kind === 'turn_complete') as any).result.text).toBe('Saved after the grant.');
  });

  it('the v0.9.99 idle protection still holds: a model repeating the refused write is told to change approach, spaced out, and answers', async () => {
    const workspace = await temporaryFolder('unode-a2-idle-workspace-');
    const outside = await temporaryFolder('unode-a2-idle-outside-');
    const target = path.join(outside, 'out.txt');
    const host = accessHost();
    const same = step(call('w-same', 'write_file', { path: target, content: 'NO' }));
    const model = scriptedModel([same, same, same, same, same, answer('The outside file needs access; nothing else is left.')]);
    const backend = host.make(workspace, model.fetchFn);
    const events = await runTurn(backend, `Write ${target}.`);

    expect(model.requests).toHaveLength(6);
    expect(events.filter((event) => event.kind === 'tool_result' && event.summary === 'blocked: repeated failing call').length).toBeGreaterThanOrEqual(2);
    expect(modelFacingText(model.requests)).toContain('[HOST NOTE] Your last 2 rounds only repeated calls that were already refused');
    expect(events.filter((event) => event.kind === 'runtime_notice' && event.text.includes('keeps repeating calls that were already refused'))).toHaveLength(1);
    expect((events.find((event) => event.kind === 'turn_complete') as any).result.text).toBe('The outside file needs access; nothing else is left.');
    expect(await fs.readdir(outside)).toEqual([]);
    // One notice for the one target, however often the write was refused.
    expect(host.presented).toEqual([target]);
  });

  describe('Off, Plan and a task ceiling stay refusals while the turn goes on, though a Read + Write grant holds the folder', () => {
    async function granted() {
      // Physical folders, as the host gives a task ceiling: an 8.3 TEMP spelling is not one.
      const workspace = await fs.realpath(await temporaryFolder('unode-a2-limit-workspace-'));
      const outside = await fs.realpath(await temporaryFolder('unode-a2-limit-outside-'));
      const host = accessHost();
      await host.owner.requestPathAccess(outside, { requestId: 'r1', isCurrent: () => true },
        async () => ({ permission: 'readwrite', lifetime: 'session' }));
      const target = path.join(outside, 'out.txt');
      const model = scriptedModel([
        step(call('w-limit', 'write_file', { path: target, content: 'NO' }), call('r-ws', 'list_dir', { path: '.' })),
        answer('The limit stays; listed the workspace.'),
      ]);
      return { workspace, outside, host, target, model };
    }
    const expectRefusedAndContinued = async (h: Awaited<ReturnType<typeof granted>>, events: BackendEvent[]) => {
      expect(results(events, 'write_file').map((event) => event.outcome.status)).toEqual(['refused']);
      expect(results(events, 'list_dir').map((event) => event.outcome.status)).toEqual(['success']);
      expect(h.model.requests).toHaveLength(2);
      expect((events.find((event) => event.kind === 'turn_complete') as any).result.text).toBe('The limit stays; listed the workspace.');
      expect(await fs.readdir(h.outside)).toEqual([]);
    };

    it('Off: an agent without file writes is refused the write', async () => {
      const h = await granted();
      const events = await runTurn(h.host.make(h.workspace, h.model.fetchFn, ['read']), `Write ${h.target}.`);
      await expectRefusedAndContinued(h, events);
    });

    it('Plan: a Plan turn is refused the write', async () => {
      const h = await granted();
      const events = await runTurn(h.host.make(h.workspace, h.model.fetchFn), `Write ${h.target}.`, { mode: 'plan' });
      await expectRefusedAndContinued(h, events);
    });

    it('a task ceiling that does not include the folder refuses the write', async () => {
      const h = await granted();
      const events = await runTurn(h.host.make(h.workspace, h.model.fetchFn), `Write ${h.target}.`,
        { taskWorkspaceAccess: { pathBase: h.workspace, commandCwd: h.workspace, readRoots: [h.workspace], writeRoots: [h.workspace] } });
      await expectRefusedAndContinued(h, events);
    });
  });
});
