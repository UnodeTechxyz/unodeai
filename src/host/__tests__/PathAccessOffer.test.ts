import { readFileSync, statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import { createPathAccessOffer, pathAccessItemView, pathAccessNoticeText, type PathAccessOfferCause } from '../PathAccessOffer';
import { matchPathAccess, SessionLocalReadScopeConsent, type PathAccessChoice, type SessionPathAccessGrant } from '../../backend/localReadScope';
import { WorkspaceTools } from '../../backend/WorkspaceTools';
import { ChatViewProvider, type ChatViewDeps } from '../../views/ChatViewProvider';
import { renderSecurityHtml, SecurityPanel, type SecuritySnapshot } from '../../views/SecurityPanel';
import { bootWebviewScript } from '../../views/__tests__/support/webviewBoot';
import { MessageBus } from '../../bus/MessageBus';
import { RunLedger } from '../../observability/RunLedger';
import { SessionManager } from '../../session/SessionManager';
import { UserRequestEntrance } from '../UserRequestEntrance';
import { endedRequestContinuation } from '../requestContinuation';
import { grantNoticeLine } from '../grantNoticeText';
import { namedOutsidePaths } from '../namedOutsidePaths';
import type { AgentBackend, BackendEvent, BackendEventHandler, ConversationSnapshot } from '../../backend/AgentBackend';
import type { AgentConfig, Message } from '../../types';

const cleanup: string[] = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-scope-offer-'));
  cleanup.push(root);
  const file = path.join(root, 'external.txt');
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  await fs.writeFile(file, 'external');
  await fs.writeFile(path.join(workspace, 'local.txt'), 'independent');
  const owner = new SessionLocalReadScopeConsent(async () => false);
  const state = new Map<string, unknown>();
  const chat = new ChatViewProvider({} as never, {
    listAgents: () => ['dev', 'other'].map((id) => ({ id, name: id, role: 'developer' })),
    send: vi.fn(), interject: vi.fn(), interrupt: vi.fn(), onReply: () => () => {},
    state: { get: (key) => state.get(key), update: async (key, value) => { state.set(key, structuredClone(value)); } },
    getApprovals: () => ({ command: 'all', write: 'none' }), setApproval: vi.fn(),
  } as ChatViewDeps);
  chat.selectAgent('dev');
  const current = chat.captureScopeDecision('dev');
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => { finish = resolve; });
  let answer!: (choice: PathAccessChoice | undefined) => void;
  const granted: SessionPathAccessGrant[] = [];
  const present = vi.fn(async () => true);
  const choose = vi.fn(() => new Promise<PathAccessChoice | undefined>((resolve) => { answer = resolve; }));
  let allowed = true;
  const unavailable = vi.fn(finish);
  const offer = createPathAccessOffer({ owner, canOffer: () => allowed,
    captureRequest: () => ({ requestId: 'r1', isCurrent: current }), present, choose,
    granted: (grant) => { granted.push(grant); finish(); }, unavailable, requestEnded: finish });
  const nextChoice = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return { root, file, workspace, owner, chat, offer, present, choose, granted, settled, nextChoice, unavailable,
    answer: (choice: PathAccessChoice | undefined) => answer(choice), restrict: () => { allowed = false; } };
}

describe('recoverable path access over the real chat cancellation and scope stores', () => {
  it('an existing restriction does not offer a choice it cannot grant', async () => {
    const h = await harness();
    h.restrict();
    h.offer(h.file);
    await h.nextChoice();
    expect(h.present).not.toHaveBeenCalled();
    expect(h.choose).not.toHaveBeenCalled();
    expect(h.owner.listPathAccess()).toEqual([]);
  });

  // v0.9.100 (field, 4523a765): a path the request names is offered as it starts, with words that say so; a refused
  // tool's offer keeps its own words. Audit of aaf794a2: a person who chose Read at the start is still offered the write
  // a later refusal shows was needed. v0.9.101 (F2): that is one Read + Write notice, once.
  it('presents why it offers, and after a Read at the start a refused write gets one Read + Write notice', async () => {
    const h = await harness();
    h.offer(h.file, 'named');
    await h.nextChoice();
    expect(h.present).toHaveBeenCalledWith(h.file, 'named', { label: 'File external.txt', upgrade: false });
    h.offer(h.file, 'named');
    await h.nextChoice();
    expect(h.present).toHaveBeenCalledTimes(1);
    // The person chooses Read for the session at the start.
    h.answer({ permission: 'read', lifetime: 'session' });
    await h.settled;
    expect(matchPathAccess(h.owner.pathAccessFor('r1'), h.file, 'read')).toBeTruthy();
    expect(matchPathAccess(h.owner.pathAccessFor('r1'), h.file, 'readwrite')).toBeFalsy();
    // The write is then refused in the same request: that refusal is offered.
    h.offer(h.file);
    await h.nextChoice();
    expect(h.present).toHaveBeenCalledTimes(2);
    expect(h.present).toHaveBeenLastCalledWith(h.file, 'refused', { label: 'File external.txt', upgrade: true });
    // And only once.
    h.offer(h.file);
    await h.nextChoice();
    expect(h.present).toHaveBeenCalledTimes(2);
  });

  it('the extension offers what a starting request names, in the named words', () => {
    const source = readFileSync('src/extension.ts', 'utf8');
    expect(source).toContain('userRequestStarted: (config, text) => offerNamedOutsidePaths(config, text),');
    expect(source).toContain("if (!covered) offer(target, 'named');");
    expect(source).toContain('pathAccessNoticeText(scopedConfig.name, named, cause, notice),');
    expect(source).toContain('item: (item) => chatViewProvider?.showPathAccessItem(scopedConfig.id, pathAccessItemView(item)),');
    expect(pathAccessNoticeText('Roam', '/x/lease.docx', 'named', { label: 'File lease.docx', upgrade: false }))
      .toBe('File lease.docx — your request names it, outside this workspace, and Roam cannot reach it yet. Grant access now so the work can use it. Full path: /x/lease.docx');
    expect(pathAccessNoticeText('Roam', '/x/out', 'refused', { label: 'Folder out', upgrade: false }))
      .toBe('Folder out — Roam could not reach it with the file tools. Current work continues without it. Full path: /x/out');
  });

  it('dismissal adds no grant and no follow-up notification', async () => {
    const h = await harness();
    h.offer(h.file);
    await h.nextChoice();
    h.answer(undefined);
    await h.nextChoice(); await h.nextChoice();
    expect(h.granted).toEqual([]);
    expect(h.unavailable).not.toHaveBeenCalled();
    expect(h.owner.listPathAccess()).toEqual([]);
  });

  it('the real Security webview revoke button reaches the scope owner', async () => {
    const h = await harness();
    h.offer(h.file);
    await h.nextChoice();
    h.answer({ permission: 'readwrite', lifetime: 'session' });
    await h.settled;
    const snapshot: SecuritySnapshot = {
      workspaceTrusted: true, virtualWorkspace: false, commandApproval: 'all', writeApproval: 'none',
      concurrencyStrategy: 'optimistic', fetchCatalog: false, egressGrants: [], mcpServers: [], providers: [],
      pathAccessGrants: h.owner.listPathAccess(),
    };
    const grantId = snapshot.pathAccessGrants![0].id;
    let click!: () => void;
    const button = { getAttribute: () => grantId, addEventListener: (_type: string, listener: () => void) => { click = listener; } };
    const page = bootWebviewScript(renderSecurityHtml(snapshot, "default-src 'none'", 'test'), {
      document: { querySelectorAll: (selector) => selector === 'button[data-path-grant]' ? [button] : [] },
    });
    click();
    const posted = page.postedMessages.at(-1);
    expect(posted).toEqual({ command: 'revokePathAccess', id: grantId });
    (SecurityPanel.prototype as any).onMessage.call({ deps: { revokePathAccess: (id: string) => h.owner.revokePathAccess(id) },
      render: async () => {} }, posted);
    expect(matchPathAccess(h.owner.pathAccessFor('r1'), h.file, 'readwrite')).toBeUndefined();
  });

  it('shares the notice and lets an independent host call finish while the scope choice waits', async () => {
    const h = await harness();
    h.offer(h.file); h.offer(h.file);
    await h.nextChoice();
    const other = new WorkspaceTools(h.workspace, new Set(['read']));
    expect((await other.run('read_file', { path: 'local.txt' })).output).toContain('independent');
    expect(h.present).toHaveBeenCalledTimes(1);
    expect(h.choose).toHaveBeenCalledTimes(1);
    expect(h.granted).toEqual([]);
    h.answer({ permission: 'read', lifetime: 'request' });
    await h.settled;
    expect(matchPathAccess(h.owner.pathAccessFor('r1'), h.file, 'read')).toBeDefined();
  });

  it.each(['clear', 'stop', 'remove'] as const)('%s cancels a pending grant without reviving it as a session grant', async (how) => {
    const h = await harness();
    h.offer(h.file);
    await h.nextChoice();
    if (how === 'clear') h.chat.clearSelectedAgent();
    else if (how === 'stop') h.chat.stopWaitingSends(['dev']);
    else h.chat.clearAgent('dev');
    h.answer({ permission: 'readwrite', lifetime: 'session' });
    await h.settled;
    expect(h.granted).toEqual([]);
    expect(h.owner.listPathAccess()).toEqual([]);
  });

  it('a Stop of another agent does not cancel this choice', async () => {
    const h = await harness();
    h.offer(h.file);
    await h.nextChoice();
    h.chat.stopWaitingSends(['other']);
    h.answer({ permission: 'read', lifetime: 'request' });
    await h.settled;
    expect(h.granted).toHaveLength(1);
  });

  it('the agents\' notice answers by the decision, and each grant is told on its own', async () => {
    const source = await fs.readFile('src/extension.ts', 'utf8');
    expect(source).toContain('decisionCurrent: scopeDecisionCurrent };');
    expect(source).toContain('sessionManager.tellFileAccessGrant(scopedConfig.id, requestId,');
    expect(source).toContain('const line = grantNoticeLine(report, grant.lifetime, continueOffered);');
  });

  // v0.9.100 field (T2): the first turn lasts seconds and the notice stays. A click after it did nothing at all.
  describe('a notice answered after its turn ended', () => {
    async function late(request: { running: boolean; cancelled?: boolean }) {
      const h = await harness();
      const lifetimes: boolean[] = [];
      const granted: Array<{ grant: SessionPathAccessGrant; running: boolean; requestId: string | undefined }> = [];
      const unavailable = vi.fn();
      const requestEnded = vi.fn();
      let click!: (yes: boolean) => void;
      let answer!: (choice: PathAccessChoice | undefined) => void;
      const decision = h.chat.captureScopeDecision('dev');
      const offer = createPathAccessOffer({ owner: h.owner, canOffer: () => true,
        captureRequest: () => {
          let turn = true;
          queueMicrotask(() => { turn = false; });
          return { requestId: 'r1', isCurrent: () => turn, requestCurrent: () => request.running, decisionCurrent: decision };
        },
        present: () => new Promise<boolean>((resolve) => { click = resolve; }),
        choose: (_target, forRequest) => { lifetimes.push(forRequest); return new Promise((resolve) => { answer = resolve; }); },
        granted: (grant, running, requestId) => { granted.push({ grant, running, requestId }); }, unavailable, requestEnded });
      offer(h.file);
      await h.nextChoice();
      if (request.cancelled) h.chat.stopWaitingSends(['dev']);
      click(true);
      await h.nextChoice(); await h.nextChoice();
      return { h, lifetimes, granted, unavailable, requestEnded, answer: (choice: PathAccessChoice | undefined) => answer?.(choice) };
    }

    it('still opens the choice, for the session only, and tells the agent nothing once the request is over', async () => {
      const t = await late({ running: false });
      expect(t.lifetimes).toEqual([false]);
      t.answer({ permission: 'readwrite', lifetime: 'session' });
      await t.h.nextChoice(); await t.h.nextChoice();
      expect(t.granted).toHaveLength(1);
      expect(t.granted[0].running).toBe(false);
      expect(matchPathAccess(t.h.owner.pathAccessFor('next-request'), t.h.file, 'readwrite')).toBeDefined();
    });

    it('offers this request too while the request goes on, and the running agent is told', async () => {
      const t = await late({ running: true });
      expect(t.lifetimes).toEqual([true]);
      t.answer({ permission: 'read', lifetime: 'request' });
      await t.h.nextChoice(); await t.h.nextChoice();
      expect(t.granted[0].running).toBe(true);
      expect(t.granted[0].requestId).toBeTruthy();
    });

    it('after Stop it opens no choice and says so', async () => {
      const t = await late({ running: false, cancelled: true });
      expect(t.lifetimes).toEqual([]);
      expect(t.unavailable).toHaveBeenCalledTimes(1);
      expect(t.h.owner.listPathAccess()).toEqual([]);
    });

    it('a request grant chosen as the request ended is taken back and not reported as granted', async () => {
      const state = { running: true };
      const t = await late(state);
      state.running = false;
      t.answer({ permission: 'read', lifetime: 'request' });
      await t.h.nextChoice(); await t.h.nextChoice();
      expect(t.granted).toEqual([]);
      // Field, 4c06a304 T2: the reason given was none of what happened, and no next step followed from it.
      expect(t.requestEnded).toHaveBeenCalledTimes(1);
      expect(t.unavailable).not.toHaveBeenCalled();
      expect(t.h.owner.listPathAccess()).toEqual([]);
    });
  });

  it('a new explicit restriction during the choice is kept', async () => {
    const h = await harness();
    h.offer(h.file);
    await h.nextChoice();
    h.restrict();
    h.answer({ permission: 'readwrite', lifetime: 'session' });
    await h.settled;
    expect(h.granted).toEqual([]);
  });
});

/**
 * v0.9.101 (F2, field aebbd520): one actionable state per target of a request. The notices go through a stubbed
 * `window` whose calls are counted, wired as the extension wires its ports; the chat item is the real ChatViewProvider
 * card and its Grant access the real webview message; grants go through the real SessionLocalReadScopeConsent.
 */
describe('v0.9.101 F2: one actionable state per target', () => {
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };

  async function f2() {
    const h = await harness();
    const toasts: Array<{ text: string; answer: (choice: string | undefined) => void }> = [];
    const window = {
      showWarningMessage: vi.fn((text: string, ..._items: string[]) =>
        new Promise<string | undefined>((resolve) => { toasts.push({ text, answer: resolve }); })),
      showInformationMessage: vi.fn(async (_text: string) => undefined),
    };
    const answers: Array<(choice: PathAccessChoice | undefined) => void> = [];
    const choose = vi.fn(() => new Promise<PathAccessChoice | undefined>((resolve) => { answers.push(resolve); }));
    const granted: SessionPathAccessGrant[] = [];
    const requested = vi.spyOn(h.owner, 'requestPathAccess');
    const current = h.chat.captureScopeDecision('dev');
    const offer = createPathAccessOffer({ owner: h.owner, canOffer: () => true,
      captureRequest: () => ({ requestId: 'r1', isCurrent: current }),
      // As src/extension.ts wires them.
      present: async (named, cause, notice) => await window.showWarningMessage(
        pathAccessNoticeText('dev', named, cause, notice), 'Grant access') === 'Grant access',
      item: (item) => h.chat.showPathAccessItem('dev', pathAccessItemView(item)),
      satisfied: (label, permission) => {
        void window.showInformationMessage(`${label} already has ${permission === 'readwrite' ? 'Read + Write' : 'Read'} access. Nothing was changed.`);
      },
      isDirectory: (target) => statSync(target, { throwIfNoEntry: false })?.isDirectory(),
      choose, granted: (grant) => { granted.push(grant); }, unavailable: vi.fn(), requestEnded: vi.fn() });
    const items = () => ((h.chat as any).currentState().messages as any[]).filter((message) => message.outcomeCard)
      .map((message) => message.outcomeCard as { outcomeId: string; title: string; detail: string; action?: { kind: string; label: string } });
    const clickItem = async (outcomeId: string) => {
      await (h.chat as any).onMessage({ command: 'repairAction', kind: 'grant-path-access', outcomeId }, 'sidebar');
      await flush();
    };
    const pick = async (choice: PathAccessChoice | undefined) => { answers.shift()!(choice); await flush(); };
    const toast = async (index: number, choice: string | undefined) => { toasts[index].answer(choice); await flush(); };
    const say = async (target: string, cause: PathAccessOfferCause) => { offer(target, cause); await flush(); };
    return { ...h, window, toasts, choose, granted, requested, items, clickItem, pick, toast, say };
  }

  it('named, then refused for the same target: one notice and one item; granting from the item closes both', async () => {
    const t = await f2();
    await t.say(t.file, 'named');
    await t.say(t.file, 'refused');
    expect(t.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(t.items()).toHaveLength(1);
    const [item] = t.items();
    expect(item).toMatchObject({ title: 'File external.txt — not granted yet', action: { kind: 'grant-path-access', label: 'Grant access' } });
    expect(item.detail).toContain(`Full path: ${t.file}`);

    // Grant access in the chat item: the same handler opens the one picker.
    await t.clickItem(item.outcomeId);
    expect(t.choose).toHaveBeenCalledTimes(1);
    expect(t.items()[0].title).toBe('File external.txt — choosing access');
    expect(t.items()[0].action).toBeUndefined();
    // A second click while the picker is open asks nothing more.
    await t.clickItem(item.outcomeId);
    expect(t.choose).toHaveBeenCalledTimes(1);
    await t.pick({ permission: 'readwrite', lifetime: 'request' });
    expect(t.granted).toHaveLength(1);
    expect(t.items()).toEqual([expect.objectContaining({ outcomeId: item.outcomeId, title: 'File external.txt — Read + Write access granted' })]);
    expect(t.items()[0].action).toBeUndefined();

    // The older notice, answered now, finds the grant: no second request, no second grant, a short fact instead.
    await t.toast(0, 'Grant access');
    expect(t.requested).toHaveBeenCalledTimes(1);
    expect(t.choose).toHaveBeenCalledTimes(1);
    expect(t.granted).toHaveLength(1);
    expect(t.window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(t.window.showInformationMessage).toHaveBeenCalledWith('File external.txt already has Read + Write access. Nothing was changed.');

    // Another cause for a target already reached shows nothing.
    await t.say(t.file, 'refused');
    await t.say(t.file, 'named');
    expect(t.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(t.items()).toHaveLength(1);
  });

  it('two targets are told apart by kind and name first, and two of one name by their folder', async () => {
    const t = await f2();
    const contract = path.join(t.root, 'contracts', 'MetaBlox_contract.docx');
    const output = path.join(t.root, 'output');
    await fs.mkdir(path.dirname(contract)); await fs.writeFile(contract, 'contract'); await fs.mkdir(output);
    await t.say(contract, 'named');
    await t.say(output, 'named');
    expect(t.window.showWarningMessage).toHaveBeenCalledTimes(2);
    const [first, second] = t.toasts.map((shown) => shown.text);
    expect(first.startsWith('File MetaBlox_contract.docx — ')).toBe(true);
    expect(second.startsWith('Folder output — ')).toBe(true);
    expect(first.endsWith(`Full path: ${contract}`)).toBe(true);
    expect(second.endsWith(`Full path: ${output}`)).toBe(true);
    expect(t.items().map((item) => item.title)).toEqual(['File MetaBlox_contract.docx — not granted yet', 'Folder output — not granted yet']);

    const a = path.join(t.root, 'a', 'report.docx');
    const b = path.join(t.root, 'b', 'report.docx');
    await t.say(a, 'refused');
    await t.say(b, 'refused');
    expect(t.toasts[3].text.startsWith(`File b${path.sep}report.docx — `)).toBe(true);
    expect(t.items().map((item) => item.title).slice(2)).toEqual([`File a${path.sep}report.docx — not granted yet`, `File b${path.sep}report.docx — not granted yet`]);
  });

  it('Read granted, then a write refused: one Read + Write notice, once, and its Grant access reaches the picker', async () => {
    const t = await f2();
    await t.say(t.file, 'named');
    await t.toast(0, 'Grant access');
    await t.pick({ permission: 'read', lifetime: 'session' });
    expect(t.items()[0].title).toBe('File external.txt — Read access granted');
    // A later named notice for it has nothing to offer.
    await t.say(t.file, 'named');
    expect(t.window.showWarningMessage).toHaveBeenCalledTimes(1);

    await t.say(t.file, 'refused');
    expect(t.window.showWarningMessage).toHaveBeenCalledTimes(2);
    expect(t.toasts[1].text).toBe(`File external.txt — dev has Read access; saving there needs Read + Write. Full path: ${t.file}`);
    expect(t.items()).toHaveLength(1);
    expect(t.items()[0]).toMatchObject({ title: 'File external.txt — has Read; saving needs Read + Write access', action: { kind: 'grant-path-access' } });
    // The same gap, refused again, is not shown again.
    await t.say(t.file, 'refused');
    expect(t.window.showWarningMessage).toHaveBeenCalledTimes(2);

    await t.toast(1, 'Grant access');
    expect(t.choose).toHaveBeenCalledTimes(2);
    await t.pick({ permission: 'readwrite', lifetime: 'session' });
    expect(matchPathAccess(t.owner.pathAccessFor('r1'), t.file, 'readwrite')).toBeDefined();
    expect(t.items()[0].title).toBe('File external.txt — Read + Write access granted');
    expect(t.granted).toHaveLength(2);
  });

  it('the rendered item\'s Grant access posts only the host-issued id, and the host opens the one picker', async () => {
    const t = await f2();
    await t.say(t.file, 'refused');
    const [item] = t.items();
    expect(item.outcomeId).toMatch(/^path-access-[0-9a-f-]{36}$/);
    const page = bootWebviewScript((t.chat as any).getHtml({ cspSource: 'test:' }, 'sidebar'));
    for (const listener of page.listeners.message ?? []) listener({ data: { command: 'state', state: (t.chat as any).currentState() } });
    const descendants = (node: any): any[] => (Array.isArray(node.children) ? node.children : []).flatMap((child: any) => [child, ...descendants(child)]);
    const card = descendants(page.elements.get('transcript')!).find((node) => String(node.className).includes('outcome-repair'));
    expect(descendants(card).map((node) => String(node.textContent)).filter(Boolean)).toEqual(expect.arrayContaining(
      ['File external.txt — not granted yet', 'Grant access']));
    for (const listener of page.listeners.click ?? []) {
      try { listener({ preventDefault() {}, stopPropagation() {}, target: {} }); } catch { /* unrelated control */ }
    }
    const posted = page.postedMessages.find((message: any) => message.command === 'repairAction' && message.kind === 'grant-path-access');
    expect(posted).toEqual({ command: 'repairAction', kind: 'grant-path-access', outcomeId: item.outcomeId });
    await (t.chat as any).onMessage(posted, 'sidebar');
    await flush();
    expect(t.choose).toHaveBeenCalledTimes(1);
    expect(t.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });
});

/**
 * v0.9.101 (§4.2, T101-2 first branch, T101-10): a request the agent answers without a tool keeps its access item, and a
 * grant made once that request ended offers Continue. Through the real SessionManager, MessageBus, RunLedger,
 * UserRequestEntrance, ChatViewProvider card and SessionLocalReadScopeConsent; the model is a scripted backend and the
 * notice and picker are counted stubs. The ports are wired as src/extension.ts wires them.
 */
describe('v0.9.101 §4.2: an access item after a no-tool answer, and Continue', () => {
  class ScriptedBackend implements AgentBackend {
    readonly agentId: string;
    pid = 1;
    turns: string[] = [];
    private handler?: BackendEventHandler;
    private alive = false;
    constructor(config: AgentConfig) { this.agentId = config.id; }
    onEvent(h: BackendEventHandler): () => void { this.handler = h; return () => { this.handler = undefined; }; }
    async start(): Promise<void> { this.alive = true; }
    sendUserTurn(instruction: string): void { this.turns.push(instruction); }
    async stop(): Promise<void> { this.alive = false; this.emit({ kind: 'exit', code: 0 }); }
    abort(): void {}
    isAlive(): boolean { return this.alive; }
    readonly snapshotKind = 'openai-compat' as const;
    snapshot(): ConversationSnapshot { return { version: 1, messages: [] }; }
    restore(): boolean { return true; }
    emit(e: BackendEvent): void { this.handler?.(e); }
  }
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const agentConfig = (id: string, role: string): AgentConfig => ({
    id, name: id, role: role as AgentConfig['role'], skill: '', provider: { providerId: 'anthropic', apiKeySecretName: 'K' },
    model: 'claude-sonnet-4-20250514', systemPrompt: '', autoApprove: true, allowedTools: [],
  });

  async function flow(agentId: 'dev' | 'pm' = 'dev', closing?: () => Promise<void>) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-continue-'));
    cleanup.push(root);
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    const file = path.join(root, 'lease.txt');
    await fs.writeFile(file, 'lease');
    const bus = new MessageBus();
    const ledger = new RunLedger();
    bus.subscribe({}, (message) => ledger.observeMessage(message));
    const owner = new SessionLocalReadScopeConsent(async () => false);
    const backends = new Map<string, ScriptedBackend>();
    const mgr: SessionManager = new SessionManager(5, bus, {
      createBackend: (cfg) => { const made = new ScriptedBackend(cfg); backends.set(cfg.id, made); return made; },
      resolveEnv: async () => ({}),
      onTurnComplete: closing,
      continuationDecided: (coordinatorId, correlationId) => ledger.beginContinuation(coordinatorId, correlationId),
      continuationAbandoned: (coordinatorId, correlationId) => ledger.abandonContinuation(coordinatorId, correlationId),
      threadRunOpen: (coordinatorId, correlationId) => ledger.threadRunOpen(coordinatorId, correlationId),
      replyEndsContinuation: (coordinatorId, correlationId, replyCorrelationId) => ledger.replyEndsContinuation(coordinatorId, correlationId, replyCorrelationId),
      // As src/extension.ts's offerNamedOutsidePaths: each outside path the message names that no grant covers.
      userRequestStarted: (config, text) => {
        const grants = owner.pathAccessFor(mgr.currentRequestId(config.id));
        for (const target of namedOutsidePaths(text, [workspace])) {
          if (!matchPathAccess(grants, target, 'read')) offer(target, 'named');
        }
      },
    });
    const state = new Map<string, unknown>();
    const chat = new ChatViewProvider({} as never, {
      listAgents: () => ['dev', 'pm'].map((id) => ({ id, name: id, role: id === 'pm' ? 'project-manager' : 'developer' })),
      send: vi.fn(), interject: vi.fn(), interrupt: vi.fn(), onReply: () => () => {},
      state: { get: (key) => state.get(key), update: async (key, value) => { state.set(key, structuredClone(value)); } },
      getApprovals: () => ({ command: 'all', write: 'none' }), setApproval: vi.fn(),
    } as ChatViewDeps);
    chat.selectAgent(agentId);
    const entrance = new UserRequestEntrance({
      beginUserRequest: () => owner.beginUserRequest(), bus,
      agents: { has: (id) => mgr.get(id) !== undefined, isRunning: (id) => mgr.isRunning(id), start: (id) => mgr.start(id, { pin: 'reuse' }) },
    });
    const window = {
      showWarningMessage: vi.fn((_text: string, ..._items: string[]) => new Promise<string | undefined>(() => {})),
    };
    const answers: Array<(choice: PathAccessChoice | undefined) => void> = [];
    const lifetimes: boolean[] = [];
    const choose = vi.fn((_target: unknown, forRequest: boolean) => {
      lifetimes.push(forRequest);
      return new Promise<PathAccessChoice | undefined>((resolve) => { answers.push(resolve); });
    });
    const lines: string[] = [];
    const unavailable = vi.fn();
    const offer = createPathAccessOffer({ owner, canOffer: () => true,
      captureRequest: () => {
        const requestId = mgr.currentRequestId(agentId);
        const turnId = mgr.currentTurnId(agentId);
        if (!requestId || !turnId) return undefined;
        const decision = chat.captureScopeDecision(agentId);
        return { requestId, isCurrent: () => decision() && mgr.currentRequestId(agentId) === requestId && mgr.currentTurnId(agentId) === turnId,
          requestCurrent: () => mgr.requestRunning(requestId), decisionCurrent: decision };
      },
      present: async (named, cause, notice) => await window.showWarningMessage(
        pathAccessNoticeText(agentId, named, cause, notice), 'Grant access') === 'Grant access',
      item: (item) => chat.showPathAccessItem(agentId, pathAccessItemView(item)),
      isDirectory: (target) => statSync(target, { throwIfNoEntry: false })?.isDirectory(),
      choose,
      continuation: (requestId) => endedRequestContinuation({
        agentId,
        hasStructuredPreparation: (id) => mgr.requestHasStructuredPreparation(agentId, id),
        originalRequest: (id) => {
          const turnId = mgr.requestOriginTurnId(id);
          return turnId ? bus.getThread(turnId).find((message) => message.id === turnId) : undefined;
        },
        resubmit: (request) => entrance.resubmit(agentId, request),
      }, requestId),
      granted: (grant, _current, requestId, continueOffered) => {
        if (!requestId) return;
        mgr.tellFileAccessGrant(agentId, requestId, 'Host scope update: access is now available.', (report) => {
          const line = grantNoticeLine(report, grant.lifetime, continueOffered);
          if (line) lines.push(line);
        });
      },
      unavailable, requestEnded: vi.fn() });
    mgr.create(agentConfig(agentId, agentId === 'pm' ? 'project-manager' : 'senior-dev'));
    await mgr.start(agentId, { pin: 'take' });
    const backend = backends.get(agentId)!;
    backend.emit({ kind: 'ready' });
    const items = () => ((chat as any).currentState().messages as any[]).filter((message) => message.outcomeCard)
      .map((message) => message.outcomeCard as { outcomeId: string; title: string; detail: string; state: string; action?: { kind: string; label: string } });
    const click = async (kind: 'grant-path-access' | 'continue-request', outcomeId = items()[0].outcomeId) => {
      (chat as any).onMessage({ command: 'repairAction', kind, outcomeId }, 'sidebar');
      await flush();
    };
    const pick = async (choice: PathAccessChoice | undefined) => { answers.shift()!(choice); await flush(); };
    const ask = async (instruction: string, mode: 'plan' | 'act' = 'act') => {
      entrance.submit(agentId, 'ask.question', { instruction, mode });
      await flush();
      return mgr.currentRequestId(agentId)!;
    };
    const answer = async (text = 'Here is my answer.') => {
      backend.emit({ kind: 'turn_complete', result: { text, isError: false } } as BackendEvent);
      await flush();
    };
    const requests = () => bus.query({ type: 'ask.question' }).filter((message) => message.from === 'user' && message.to === agentId);
    return { root, file, workspace, bus, ledger, owner, mgr, chat, backend, window, choose, lifetimes, lines,
      unavailable, items, click, pick, ask, answer, requests };
  }

  // Local chain on an 8.3 TEMP: a grant is kept under its physical path, so a target named through a short name, a
  // junction or a link never matched it, and its item kept saying "not granted yet" after the grant.
  it('a path named through a link shows as granted once its own item granted it', async () => {
    const t = await flow();
    const linked = path.join(t.root, 'linked');
    await fs.mkdir(path.join(t.root, 'real'));
    await fs.writeFile(path.join(t.root, 'real', 'lease.txt'), 'lease');
    await fs.symlink(path.join(t.root, 'real'), linked, process.platform === 'win32' ? 'junction' : 'dir');
    await t.ask(`Summarise ${path.join(linked, 'lease.txt')} for me`);
    await t.answer('I cannot open that file.');
    await t.click('grant-path-access');
    await t.pick({ permission: 'read', lifetime: 'session' });
    expect(t.items()).toEqual([expect.objectContaining({ title: 'File lease.txt — Read access granted' })]);
  });

  // Security re-audit (F2): each path's item held its own Continue, so two paths granted after the request ended each
  // sent the request again.
  it('two paths of one ended request: Continue sends the request again once, and the other item\'s Continue is withdrawn', async () => {
    const t = await flow();
    const second = path.join(t.root, 'annex.txt');
    await fs.writeFile(second, 'annex');
    const instruction = `Compare ${t.file} with ${second}`;
    await t.ask(instruction);
    await t.answer('I cannot open those files.');
    for (const item of t.items()) {
      await t.click('grant-path-access', item.outcomeId);
      await t.pick({ permission: 'read', lifetime: 'session' });
    }
    const offered = t.items().filter((item) => item.action?.kind === 'continue-request');
    expect(offered).toHaveLength(2);
    await t.click('continue-request', offered[0].outcomeId);
    expect(t.items().filter((item) => item.action?.kind === 'continue-request')).toEqual([]);
    await t.click('continue-request', offered[1].outcomeId);
    expect(t.requests()).toHaveLength(2);
    expect(t.backend.turns).toEqual([instruction, instruction]);
  });

  // Security re-audit (F1): a teammate's item offered Continue for the coordinator's request and sent it to the teammate.
  it('Continue goes on only with a request addressed to the agent whose item it is', () => {
    const original = { id: 'm1', from: 'user', to: 'pm', type: 'ask.question', payload: { instruction: 'Plan it.' } } as unknown as Message;
    const deps = (agentId: string) => ({ agentId, hasStructuredPreparation: () => false, originalRequest: () => original, resubmit: vi.fn(async () => true) });
    expect(endedRequestContinuation(deps('dev'), 'r1')).toBeUndefined();
    expect(endedRequestContinuation(deps('pm'), 'r1')).toBeDefined();
  });

  it('a no-tool answer keeps the item; a grant after it ended offers Continue, which starts the original request once, to the same agent', async () => {
    const t = await flow();
    const instruction = `Summarise ${t.file} for me`;
    const request = await t.ask(instruction);
    // The candidate never holds the answer back: the turn is with the agent at once, with nothing granted.
    expect(t.backend.turns).toEqual([instruction]);
    expect(t.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(t.items()).toEqual([expect.objectContaining({ title: 'File lease.txt — not granted yet', action: { kind: 'grant-path-access', label: 'Grant access' } })]);

    await t.answer('I cannot open that file.');
    expect(t.mgr.requestRunning(request)).toBe(false);
    // The request's item is still there, and still grants: not only the toast.
    expect(t.items()).toEqual([expect.objectContaining({ title: 'File lease.txt — not granted yet', action: { kind: 'grant-path-access', label: 'Grant access' } })]);

    await t.click('grant-path-access');
    // The request has ended, so only For this session is offered.
    expect(t.lifetimes).toEqual([false]);
    await t.pick({ permission: 'read', lifetime: 'session' });
    expect(matchPathAccess(t.owner.pathAccessFor('any-later-request'), t.file, 'read')).toBeDefined();
    // The grant itself starts nothing: no turn, no request.
    expect(t.backend.turns).toHaveLength(1);
    expect(t.requests()).toHaveLength(1);
    const [item] = t.items();
    expect(item).toMatchObject({ title: 'File lease.txt — Read access granted', state: 'offered', action: { kind: 'continue-request', label: 'Continue' } });
    expect(item.detail).toContain('Continue sends it again, as a new request');
    expect(t.lines).toEqual(['The agent was not told: that request has ended. The access stays for this session. '
      + 'To go on with your request, choose Continue on its file access item in this conversation.']);

    await t.click('continue-request');
    expect(t.requests()).toHaveLength(2);
    expect(t.requests()[1].payload).toEqual({ instruction, mode: 'act' });
    expect(t.backend.turns).toEqual([instruction, instruction]);
    const next = t.mgr.currentRequestId('dev');
    expect(next).toBeDefined();
    expect(next).not.toBe(request);
    // The new request names the same file, which the session grant covers: no second notice, no second item.
    expect(t.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(t.items()).toHaveLength(1);
    expect(t.items()[0].action).toBeUndefined();
    expect(t.items()[0].detail).toContain('Your request was sent again, as a new request.');

    // A second click, also one from an older render, starts nothing, during the new turn or after it.
    await t.click('continue-request');
    await t.answer();
    await t.click('continue-request');
    expect(t.requests()).toHaveLength(2);
    expect(t.backend.turns).toHaveLength(2);
  });

  it('a grant while the request runs offers no Continue, during it or after it', async () => {
    const t = await flow();
    await t.ask(`Read ${t.file}`);
    await t.click('grant-path-access');
    expect(t.lifetimes).toEqual([true]);
    await t.pick({ permission: 'read', lifetime: 'session' });
    expect(t.items()[0].title).toBe('File lease.txt — Read access granted');
    expect(t.items()[0].action).toBeUndefined();
    await t.answer();
    await t.answer();
    expect(t.items()[0].action).toBeUndefined();
    await t.click('continue-request');
    // The running request was told and went on by itself; Continue added nothing.
    expect(t.requests()).toHaveLength(1);

    // The same while the turn's closing work still holds the request, after its reply.
    let release!: () => void;
    let hold: Promise<void> | undefined = new Promise<void>((resolve) => { release = resolve; });
    const u = await flow('dev', () => hold ?? Promise.resolve());
    const request = await u.ask(`Read ${u.file}`);
    await u.answer();
    expect(u.mgr.requestRunning(request)).toBe(true);
    await u.click('grant-path-access');
    expect(u.lifetimes).toEqual([true]);
    await u.pick({ permission: 'read', lifetime: 'session' });
    expect(u.items()[0].title).toBe('File lease.txt — Read access granted');
    expect(u.items()[0].action).toBeUndefined();
    hold = undefined;
    release();
    await flush();
    await u.answer();
    expect(u.mgr.requestRunning(request)).toBe(false);
    expect(u.items()[0].action).toBeUndefined();
    await u.click('continue-request');
    expect(u.requests()).toHaveLength(1);
  });

  it('after Stop the item grants nothing and offers no Continue; a Stop after the grant withdraws it', async () => {
    const t = await flow();
    await t.ask(`Read ${t.file}`);
    t.chat.stopWaitingSends(['dev']);
    await t.answer();
    await t.click('grant-path-access');
    expect(t.choose).not.toHaveBeenCalled();
    expect(t.unavailable).toHaveBeenCalledTimes(1);
    expect(t.items()[0].action?.kind).not.toBe('continue-request');

    const u = await flow();
    await u.ask(`Read ${u.file}`);
    await u.answer();
    await u.click('grant-path-access');
    await u.pick({ permission: 'read', lifetime: 'session' });
    expect(u.items()[0].action).toEqual({ kind: 'continue-request', label: 'Continue' });
    const { outcomeId } = u.items()[0];
    u.chat.stopWaitingSends(['dev']);
    expect(u.items()[0].action).toBeUndefined();
    expect(u.items()[0].detail).toContain('Continue was withdrawn');
    await u.click('continue-request', outcomeId);
    expect(u.requests()).toHaveLength(1);
    expect(u.backend.turns).toHaveLength(1);
  });

  it('a request with a structured preparation (an open run) is not offered Continue', async () => {
    const t = await flow('pm');
    const instruction = `Plan the work on ${t.file}`;
    const request = await t.ask(instruction);
    const origin = t.requests()[0];
    t.ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'w1', agentId: 'dev', requestedAgent: 'dev',
      instruction: 'do the work', attemptId: 'attempt-w1', originCorrelationId: origin.correlationId ?? origin.id });
    await t.answer('Waiting for the worker.');
    expect(t.mgr.requestRunning(request)).toBe(false);
    expect(t.mgr.requestHasStructuredPreparation('pm', request)).toBe(true);
    await t.click('grant-path-access');
    await t.pick({ permission: 'read', lifetime: 'session' });
    expect(t.items()[0].title).toBe('File lease.txt — Read access granted');
    expect(t.items()[0].action).toBeUndefined();
    expect(t.lines.join('\n')).not.toContain('Continue');
    expect(t.requests()).toHaveLength(1);
  });

  it('a Plan grant starts nothing and switches nothing; its Continue sends the Plan request again as Plan', async () => {
    const t = await flow();
    const instruction = `What would you change in ${t.file}?`;
    await t.ask(instruction, 'plan');
    await t.answer('A plan.');
    await t.click('grant-path-access');
    await t.pick({ permission: 'readwrite', lifetime: 'session' });
    expect(t.backend.turns).toHaveLength(1);
    expect(t.requests()).toHaveLength(1);
    expect(t.items()[0].action).toEqual({ kind: 'continue-request', label: 'Continue' });
    await t.click('continue-request');
    expect(t.requests()).toHaveLength(2);
    expect(t.requests()[1].payload).toEqual({ instruction, mode: 'plan' });
  });

  it('a simple answer naming an example path is not held back, and nothing is granted or started for it', async () => {
    const t = await flow();
    const instruction = `What does a path like ${t.file} mean?`;
    const request = await t.ask(instruction);
    expect(t.backend.turns).toEqual([instruction]);
    await t.answer('It is an absolute path.');
    expect(t.mgr.requestRunning(request)).toBe(false);
    // The notice waits unanswered and asks nothing; the person ignores it.
    expect(t.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(t.choose).not.toHaveBeenCalled();
    expect(t.owner.listPathAccess()).toEqual([]);
    expect(t.requests()).toHaveLength(1);
    expect(t.items()[0].action).toEqual({ kind: 'grant-path-access', label: 'Grant access' });
  });

  it('the extension wires Continue to the original message, the seam and the one entrance', () => {
    const source = readFileSync('src/extension.ts', 'utf8');
    expect(source).toContain('continuation: (requestId) => endedRequestContinuation({');
    expect(source).toContain('        agentId: scopedConfig.id,\n        hasStructuredPreparation:');
    expect(source).toContain('hasStructuredPreparation: (id) => sessionManager.requestHasStructuredPreparation(scopedConfig.id, id),');
    expect(source).toContain('const turnId = sessionManager.requestOriginTurnId(id);');
    expect(source).toContain('resubmit: (request) => userRequests.resubmit(scopedConfig.id, request),');
  });
});
