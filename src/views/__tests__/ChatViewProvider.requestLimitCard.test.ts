import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { ChatAgent, ChatViewDeps, ChatViewProvider } from '../ChatViewProvider';
import { ApprovalDecisionBroker, requestLimitSessionId } from '../approvals';
import {
  askRequestLimitDecision,
  requestLimitPromptText,
  requestLimitSettledText,
  type RequestLimitCard,
} from '../../host/RequestLimitPrompt';
import type { RequestCeilingDecisionFacts } from '../../host/RequestCeiling';
import { bootWebviewScript, type WebviewElement } from './support/webviewBoot';
import { codexApprovalPresentation } from '../../host/CodexApprovalPresentation';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * v0.9.94: the decision of a reached request limit is a card on the approval surface of Chat. These tests drive the
 * real view and the real webview script: what the card shows while it is open, what it shows after each way it
 * can settle, and that none of an approval's consequences follow it.
 */

const pm: ChatAgent = { id: 'pm', name: 'PM', role: 'Project Manager', backend: 'openai' };
const dev: ChatAgent = { id: 'dev', name: 'Senior Developer', role: 'Developer', backend: 'openai' };

describe('Codex approval presentation on the actual chat card', () => {
  it('renders missing shell metadata as unverified, never as the shell named in model detail', () => {
    const { provider, broker } = chat();
    const command = "Write-Output 'fallback-check'";
    const opened = provider.openApproval(codexApprovalPresentation('PM', {
      kind: 'command', title: 'Codex command', command,
      detail: `${command}\n\nShell: Codex Windows PowerShell`, timeoutMs: 60_000,
    }, { agentId: 'pm', sessionId: 'pm' }), 60_000);
    try {
      for (const container of ['sidebar', 'workbench'] as const) {
        const [shown] = rendered(provider, container).cards;
        expect(shown.lines).toContain(`appr-cmd|${command}\n\nShell: Codex provider shell (unverified)`);
        expect(shown.buttons.map((button) => button.label)).toEqual(['Allow once', 'Deny']);
      }
      expect(provider.approvalAttentionForAgent('pm')?.actionSummary).toBe(command);
    } finally {
      broker.withdraw(opened.approvalId);
    }
  });

  it.each(['Codex Windows PowerShell', 'Codex provider shell (unverified)'])(
    'renders command then host %s, not the model reason, with only once/deny actions', (shellLabel) => {
      const { provider, broker } = chat();
      const command = "Write-Output 'codex-approval-check'";
      const detail = `${command}\n\nShell: ${shellLabel}\n\nWorking directory: C:\\test\n\nVerify approval`;
      const presentation = codexApprovalPresentation('PM', {
        kind: 'command', title: 'Codex command', command, detail, shellLabel, timeoutMs: 60_000,
      }, { agentId: 'pm', sessionId: 'pm' });
      const opened = provider.openApproval(presentation, 60_000);
      try {
        expect(broker.list()[0]).toMatchObject({ agentId: 'pm', sessionId: 'pm', singleUseOnly: true });
        for (const container of ['sidebar', 'workbench'] as const) {
          const [shown] = rendered(provider, container).cards;
          expect(shown.lines).toContain(`appr-cmd|${command}\n\nShell: ${shellLabel}`);
          expect(shown.buttons.map((button) => button.label)).toEqual(['Allow once', 'Deny']);
        }
        expect(provider.approvalAttentionForAgent('pm')?.actionSummary).toBe(command);
      } finally {
        broker.withdraw(opened.approvalId);
      }
    },
  );

  it('keeps the extension wired through the tested presentation adapter', () => {
    const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
    const start = source.indexOf('async function requestCodexApproval(');
    const body = source.slice(start, source.indexOf('recordBrokeredApproval', start));
    expect(body).toContain('codexApprovalPresentation(agentName, request, origin)');
    expect(body).not.toContain('command: request.command || request.detail');
  });

  it('preserves single-use tool previews and the guardian recovery flag without inventing command grants', () => {
    expect(codexApprovalPresentation('PM', {
      kind: 'guardian-denied', title: 'Review denied', detail: 'reason', timeoutMs: 60_000, approveAnyway: true,
    }, { agentId: 'pm', sessionId: 'pm' })).toEqual({
      kind: 'tool', agentName: 'PM', toolName: 'Review denied', toolDetail: 'reason',
      singleUseOnly: true, approveAnyway: true, agentId: 'pm', sessionId: 'pm',
    });
  });
});

const card: RequestLimitCard = {
  requestId: 'request-1',
  agent: { id: 'pm', name: 'PM' },
  message: 'A request reached the limit you set. Stop it or let it continue?',
  paragraphs: [
    'Model requests: 12 observed, allowance 12.',
    'Held until you decide: the next model request.',
    'Working on this request now: PM, Senior Developer.',
  ],
};

function chat(overrides: Partial<ChatViewDeps> = {}) {
  const store = new Map<string, unknown>();
  const sounds: string[] = [];
  const repairs: unknown[] = [];
  const deps = {
    approvalBroker: new ApprovalDecisionBroker({ attention: (key) => sounds.push(key) }),
    listAgents: () => [pm, dev],
    send: vi.fn(),
    interject: vi.fn(),
    interrupt: vi.fn(),
    onReply: () => vi.fn(),
    state: {
      get: <T>(key: string) => store.get(key) as T | undefined,
      update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
    },
    getApprovals: () => ({ command: 'ask', write: 'none' }),
    setApproval: vi.fn(),
    onOutcomeRepair: (event: unknown) => repairs.push(event),
    approverIdentity: () => 'local:owner',
    ...overrides,
  } as ChatViewDeps;
  const provider = new ChatViewProvider({} as never, deps);
  provider.selectAgent(pm.id);
  return { provider, deps, sounds, repairs, broker: deps.approvalBroker! };
}

const stateOf = (provider: ChatViewProvider) => (provider as any).currentState();
const pendingOf = (provider: ChatViewProvider) => stateOf(provider).pendingApprovals as Array<Record<string, any>>;
/** The click a chat container posts. It goes through the real protocol parser. */
const click = (provider: ChatViewProvider, id: string, action: string) =>
  (provider as any).onMessage({ command: 'approvalDecision', id, action }, 'sidebar');

interface RenderedCard {
  className: string;
  id: string;
  title: string;
  /** Every line under the title as `class|text`, in order. */
  lines: string[];
  /** How many of those lines sit in the part of the card that scrolls when the container is short. */
  scrolling: number;
  buttons: Array<{ label: string; className: string }>;
  inputs: number;
}

const text = (node: WebviewElement): string => String(node.textContent ?? '');
const kids = (node: WebviewElement): WebviewElement[] => (Array.isArray(node.children) ? node.children : []) as WebviewElement[];

/** Boot the real webview script on the view's current state and read the cards it rendered. */
function rendered(provider: ChatViewProvider, container: 'sidebar' | 'workbench' = 'sidebar') {
  const boot = bootWebviewScript((provider as any).getHtml({ cspSource: 'test:' }, container));
  const approvals = boot.elements.get('approvals');
  if (!approvals) throw new Error('the chat rendered no approval surface');
  const cards: RenderedCard[] = kids(approvals).map((node) => {
    const [title, ...rest] = kids(node);
    const actions = rest.find((child) => child.className === 'appr-actions');
    // A title is either plain text or an icon followed by its text.
    const titleText = kids(title).length > 0 ? text(kids(title).at(-1)!) : text(title);
    const body = rest.find((child) => child.className === 'appr-limit-body');
    return {
      className: String(node.className),
      id: String(node.id),
      title: titleText,
      lines: rest.filter((child) => child !== actions)
        .flatMap((child) => (child === body ? kids(child) : [child]))
        .map((child) => `${String(child.className)}|${text(child)}`),
      scrolling: body ? kids(body).length : 0,
      buttons: actions ? kids(actions).map((button) => ({ label: text(button), className: String(button.className) })) : [],
      inputs: rest.filter((child) => child.className === 'appr-note').length,
    };
  });
  // Every decision a click in this render could post, in the order the buttons were created.
  const decisions = (): unknown[] => {
    const before = boot.postedMessages.length;
    for (const listener of boot.listeners.click ?? []) {
      try { listener({ preventDefault() {}, stopPropagation() {}, target: {} }); } catch { /* not a card button */ }
    }
    return boot.postedMessages.slice(before).filter((message) => (message as { command?: string }).command === 'approvalDecision');
  };
  return { cards, hidden: approvals.hidden === true, decisions };
}

/** A sidebar chat view as VS Code hands it over. */
function sidebarView() {
  const listen = () => ({ dispose: vi.fn() });
  return {
    visible: true,
    webview: { cspSource: 'test:', html: '', options: {}, postMessage: vi.fn(), onDidReceiveMessage: vi.fn(listen) },
    onDidChangeVisibility: vi.fn(listen),
    onDidDispose: vi.fn(listen),
    show: vi.fn(),
  };
}

describe('the request limit card in Chat', () => {
  it('redraws an attached chat container in the call that opens it and in the call that settles it', () => {
    const { provider } = chat();
    const view = sidebarView();
    provider.resolveWebviewView(view as never);
    expect(provider.isShowing()).toBe(true);
    const lastState = () => view.webview.postMessage.mock.calls.at(-1)![0].state;

    const opened = provider.openRequestLimitCard(card);
    expect(lastState().pendingApprovals).toEqual([expect.objectContaining({ kind: 'request-limit', limitMessage: card.message })]);
    expect(lastState().requestLimitOutcomes).toEqual([]);

    // Nothing is awaited between the wait ending and the card changing on screen.
    opened.close('expired');
    expect(lastState().pendingApprovals).toEqual([]);
    expect(lastState().requestLimitOutcomes).toEqual([expect.objectContaining({ settlement: 'expired' })]);

    // A container that is attached but not on screen shows nothing: the caller points at Chat then.
    view.visible = false;
    expect(provider.canPromptApproval()).toBe(true);
    expect(provider.isShowing()).toBe(false);
  });

  it('waits in the queue with no chat container attached, and sounds once like an approval card', () => {
    const { provider, sounds } = chat();
    expect(provider.canPromptApproval()).toBe(false);
    expect(provider.isShowing()).toBe(false);

    provider.openRequestLimitCard(card);

    expect(provider.pendingApprovalCount()).toBe(1);
    const [pending] = pendingOf(provider);
    expect(pending).toMatchObject({
      kind: 'request-limit', agentId: 'pm', agentName: 'PM', sessionId: requestLimitSessionId('request-1'),
      limitMessage: card.message, limitDetail: card.paragraphs,
    });
    expect(sounds).toEqual([`approval:${pending.id}`]);
    // The first container that is shown renders it.
    expect(rendered(provider).cards.map((shown) => shown.id)).toEqual([`approval-${pending.id}`]);
  });

  it('shows the question, the conversation, every paragraph and the two actions, Stop first', () => {
    const { provider } = chat();
    provider.openRequestLimitCard(card);
    const [pending] = pendingOf(provider);

    for (const container of ['sidebar', 'workbench'] as const) {
      const view = rendered(provider, container);
      expect(view.hidden).toBe(false);
      expect(view.cards).toEqual([{
        className: 'appr-card request-limit',
        id: `approval-${pending.id}`,
        title: card.message,
        lines: [
          'appr-limit-owner|Conversation: PM',
          ...card.paragraphs.map((paragraph) => `appr-limit-line|${paragraph}`),
        ],
        // The paragraphs scroll inside the card in a short container; the conversation and the actions do not.
        scrolling: card.paragraphs.length,
        buttons: [
          { label: 'Stop request', className: 'primary' },
          { label: 'Continue request', className: '' },
        ],
        // No note to an agent: this is not a denial of anything an agent asked for.
        inputs: 0,
      }]);
    }
  });

  it('posts the action of the button that was clicked, and offers none of an approval card\'s actions', () => {
    const { provider } = chat();
    provider.openRequestLimitCard(card);
    const [pending] = pendingOf(provider);

    expect(rendered(provider).decisions()).toEqual([
      { command: 'approvalDecision', id: pending.id, action: 'stop' },
      { command: 'approvalDecision', id: pending.id, action: 'continue' },
    ]);

    // A flag that changes an approval card's buttons changes nothing here.
    for (const flag of ['approveAnyway', 'singleUseOnly', 'crewSessionWebAccess', 'safeCommandOffer']) {
      const flagged = chat();
      flagged.provider.openRequestLimitCard(card);
      (flagged.broker.list()[0] as unknown as Record<string, unknown>)[flag] = true;
      expect(rendered(flagged.provider).cards[0].buttons.map((button) => button.label), flag)
        .toEqual(['Stop request', 'Continue request']);
    }
  });

  it('settles as the answer the person clicked, and shows which answer was given', async () => {
    for (const [action, settlement] of [['continue', 'continued'], ['stop', 'stopped']] as const) {
      const { provider } = chat();
      const opened = provider.openRequestLimitCard(card);
      const [pending] = pendingOf(provider);
      click(provider, pending.id, action);

      expect(await opened.settled).toBe(settlement);
      expect(pendingOf(provider)).toEqual([]);
      const said = requestLimitSettledText(settlement);
      expect(stateOf(provider).requestLimitOutcomes).toEqual([
        { approvalId: pending.id, settlement, title: said.message, detail: said.detail },
      ]);
      const view = rendered(provider);
      expect(view.cards).toEqual([{
        className: `appr-card request-limit settled ${settlement}`,
        id: `request-limit-settled-${pending.id}`,
        title: said.message,
        lines: [`appr-limit-line|${said.detail}`],
        scrolling: 0,
        buttons: [],
        inputs: 0,
      }]);
      expect(view.cards[0].title).toContain(action === 'continue' ? 'Continue request' : 'Stop request');
      expect(view.decisions()).toEqual([]);
    }
  });

  it('reads every action but Continue as Stop, and a click from no person as no answer', async () => {
    for (const action of ['once', 'always', 'session', 'project', 'safe', 'deny', 'Continue']) {
      const { provider } = chat();
      const opened = provider.openRequestLimitCard(card);
      click(provider, pendingOf(provider)[0].id, action);
      expect(await opened.settled, action).toBe('stopped');
      expect(stateOf(provider).requestLimitOutcomes[0].settlement, action).toBe('stopped');
    }

    const system = chat({ approverIdentity: () => 'system:test' });
    const opened = system.provider.openRequestLimitCard(card);
    click(system.provider, pendingOf(system.provider)[0].id, 'continue');
    expect(await opened.settled).toBe('ended');
    expect(stateOf(system.provider).requestLimitOutcomes[0].settlement).toBe('ended');
  });

  it('reads as stopped for want of an answer once the window passed, with no action left and no late Continue', async () => {
    const { provider } = chat();
    const opened = provider.openRequestLimitCard(card);
    const [pending] = pendingOf(provider);
    opened.close('expired');

    // Settled in the same call: the next state the webview is sent has no open card.
    expect(pendingOf(provider)).toEqual([]);
    expect(stateOf(provider).requestLimitOutcomes).toEqual([{
      approvalId: pending.id,
      settlement: 'expired',
      title: 'Request limit: stopped, no answer in time',
      detail: 'Nobody answered while this decision was open, so the request was stopped. It can no longer be continued from this card.',
    }]);
    const view = rendered(provider);
    expect(view.cards.map((shown) => [shown.className, shown.buttons])).toEqual([['appr-card request-limit settled expired', []]]);
    expect(view.decisions()).toEqual([]);

    // A Continue from a container that had not yet redrawn: dropped, and the card says what it said.
    click(provider, pending.id, 'continue');
    expect(await opened.settled).toBe('expired');
    expect(stateOf(provider).requestLimitOutcomes.map((outcome: any) => outcome.settlement)).toEqual(['expired']);
  });

  it('reads as no longer needed when the held step ended first, and never as stopped', async () => {
    const { provider } = chat();
    const opened = provider.openRequestLimitCard(card);
    const [pending] = pendingOf(provider);
    opened.close('withdrawn');

    expect(await opened.settled).toBe('withdrawn');
    expect(pendingOf(provider)).toEqual([]);
    const [outcome] = stateOf(provider).requestLimitOutcomes;
    expect(outcome).toMatchObject({ approvalId: pending.id, settlement: 'withdrawn', title: 'Request limit: decision no longer needed' });
    expect(outcome.detail).toContain('nothing was decided');
    expect(`${outcome.title} ${outcome.detail}`).not.toMatch(/stopped/i);
    const [shown] = rendered(provider).cards;
    expect(shown.className).toBe('appr-card request-limit settled withdrawn');
    expect(shown.buttons).toEqual([]);
  });

  it('reads as ended, with nothing continued, when the request is over or the host shuts down', async () => {
    for (const end of ['ended', 'disposed'] as const) {
      const { provider } = chat();
      const opened = provider.openRequestLimitCard(card);
      opened.close(end);
      expect(await opened.settled, end).toBe('ended');
      expect(stateOf(provider).requestLimitOutcomes[0], end).toMatchObject({
        settlement: 'ended', title: 'Request limit: the request ended before a decision',
      });
      expect(rendered(provider).cards[0].buttons, end).toEqual([]);
    }
  });

  it('is followed by none of an approval\'s consequences: no timeout card, no repair, no approval wording', async () => {
    const { provider, repairs } = chat();
    const events: string[] = [];
    provider.onApprovalEvent((event) => events.push(event.type));
    const opened = provider.openRequestLimitCard(card);

    // While it waits, the roster is told a decision is needed, and which kind.
    expect(provider.approvalAttentionForAgent('pm')).toMatchObject({
      state: 'waiting', kind: 'request-limit', actionSummary: 'A request reached the limit you set',
    });
    expect(provider.approvalAttentionForAgent('dev')).toBeUndefined();
    expect(stateOf(provider).announcement).toMatchObject({
      politeness: 'assertive',
      text: 'A request reached the limit you set. Stop it or let it continue? Choose Stop request or Continue request.',
    });

    opened.close('expired');
    await opened.settled;
    const state = stateOf(provider);
    expect(state.approvalOutcomes).toEqual([]);
    expect(state.approvalAttention).toBeUndefined();
    expect(provider.approvalAttentionForAgent('pm')).toBeUndefined();
    expect(repairs).toEqual([]);
    expect(state.announcement).toMatchObject({
      politeness: 'polite',
      text: 'Request limit: stopped, no answer in time. Nobody answered while this decision was open, so the request was stopped. It can no longer be continued from this card.',
    });
    expect(rendered(provider).cards.map((shown) => shown.title)).toEqual(['Request limit: stopped, no answer in time']);
    // Status surfaces still hear that something opened and settled.
    expect(events).toEqual(['pending', 'expired']);
  });

  it('keeps a settled card in its own conversation until that agent begins a later turn', async () => {
    const { provider } = chat();
    const opened = provider.openRequestLimitCard(card);
    opened.close('expired');
    await opened.settled;

    provider.selectAgent(dev.id);
    expect(stateOf(provider).requestLimitOutcomes).toEqual([]);
    expect(rendered(provider).cards).toEqual([]);
    // Another agent's turn does not clear it.
    (provider as any).onMessage({ command: 'send', agentId: dev.id, text: 'carry on', mode: 'act' });
    provider.selectAgent(pm.id);
    expect(stateOf(provider).requestLimitOutcomes).toHaveLength(1);

    (provider as any).onMessage({ command: 'send', agentId: pm.id, text: 'next task', mode: 'act' });
    expect(stateOf(provider).requestLimitOutcomes).toEqual([]);
  });

  it('keeps an open card when its agent begins a later turn or is stopped: only its opener or a click settles it', async () => {
    const { provider, broker } = chat();
    const opened = provider.openRequestLimitCard(card);
    const [pending] = pendingOf(provider);

    (provider as any).onMessage({ command: 'send', agentId: pm.id, text: 'next task', mode: 'act' });
    // What Stop does to an agent's approval cards.
    expect(broker.leave(pm.id)).toBe(0);
    expect(pendingOf(provider).map((approval) => approval.id)).toEqual([pending.id]);

    click(provider, pending.id, 'continue');
    expect(await opened.settled).toBe('continued');
  });

  it('shows a card that belongs to no known agent, and its outcome, in every conversation', async () => {
    const { provider } = chat();
    const opened = provider.openRequestLimitCard({ ...card, agent: undefined });
    const [shown] = rendered(provider).cards;
    expect(shown.lines).toEqual(card.paragraphs.map((paragraph) => `appr-limit-line|${paragraph}`));

    opened.close('expired');
    await opened.settled;
    for (const agent of [pm, dev]) {
      provider.selectAgent(agent.id);
      expect(stateOf(provider).requestLimitOutcomes.map((outcome: any) => outcome.settlement), agent.id).toEqual(['expired']);
    }
  });

  it('gives each crossing its own card, and a new card of a request replaces that request\'s settled one', async () => {
    const { provider } = chat();
    const first = provider.openRequestLimitCard(card);
    const firstId = pendingOf(provider)[0].id;
    click(provider, firstId, 'continue');
    await first.settled;
    // Another request settles too, in the same conversation.
    const other = provider.openRequestLimitCard({ ...card, requestId: 'request-2' });
    const otherId = pendingOf(provider)[0].id;
    other.close('withdrawn');
    await other.settled;
    expect(stateOf(provider).requestLimitOutcomes.map((outcome: any) => outcome.approvalId)).toEqual([firstId, otherId]);

    const second = provider.openRequestLimitCard(card);
    const secondId = pendingOf(provider)[0].id;
    expect(secondId).not.toBe(firstId);
    expect(stateOf(provider).requestLimitOutcomes.map((outcome: any) => outcome.approvalId)).toEqual([otherId]);
    expect(rendered(provider).cards.map((shown) => shown.id)).toEqual([
      `request-limit-settled-${otherId}`, `approval-${secondId}`,
    ]);
    second.close('expired');
    await second.settled;
    expect(stateOf(provider).requestLimitOutcomes.map((outcome: any) => [outcome.approvalId, outcome.settlement]))
      .toEqual([[otherId, 'withdrawn'], [secondId, 'expired']]);
  });

  it('keeps a bounded number of settled cards, dropping the oldest', async () => {
    const { provider } = chat();
    for (let index = 0; index < 11; index += 1) {
      const opened = provider.openRequestLimitCard({ ...card, requestId: `request-${index}` });
      opened.close('withdrawn');
      await opened.settled;
    }
    expect(stateOf(provider).requestLimitOutcomes).toHaveLength(8);
    expect((provider as any).requestLimitCards.size).toBe(8);
  });

  it('sits beside an approval card without changing it, and an approval\'s answer does not answer it', async () => {
    const { provider } = chat();
    const approval = provider.requestApproval({ kind: 'command', agentId: 'dev', sessionId: 'dev', agentName: 'Senior Developer', command: 'npm test' });
    const opened = provider.openRequestLimitCard(card);
    const [command, limit] = pendingOf(provider);

    const view = rendered(provider);
    expect(view.cards.map((shown) => shown.className)).toEqual(['appr-card', 'appr-card request-limit']);
    expect(view.cards[0].buttons.map((button) => button.label)).toEqual(['Allow once', 'Allow this session', 'Allow for project', 'Deny']);
    expect(view.cards[0].inputs).toBe(1);

    // "Allow this session" on the command card settles that card alone.
    click(provider, command.id, 'session');
    await expect(approval).resolves.toMatchObject({ action: 'session', settledBy: 'human' });
    expect(pendingOf(provider).map((pending) => pending.id)).toEqual([limit.id]);
    // The Continue action is no allow on an approval card.
    const second = provider.requestApproval({ kind: 'command', agentId: 'dev', sessionId: 'dev', agentName: 'Senior Developer', command: 'npm test' });
    click(provider, pendingOf(provider).find((pending) => pending.kind === 'command')!.id, 'continue');
    const outcome = await second;
    expect(['once', 'always', 'session', 'project', 'safe']).not.toContain(outcome.action);

    opened.close('ended');
    await opened.settled;
  });

  it('ends as not continued when the view is disposed, and opens no card afterwards', async () => {
    const { provider } = chat();
    const opened = provider.openRequestLimitCard(card);
    provider.dispose();

    expect(await opened.settled).toBe('ended');
    expect(() => provider.openRequestLimitCard(card)).toThrow('disposed');
    expect(provider.pendingApprovalCount()).toBe(0);
  });
});

/* The gate's decision, asked through the real view: the answer and what the card shows cannot disagree. */
describe('the request limit decision asked in Chat', () => {
  const facts: RequestCeilingDecisionFacts = {
    requestId: 'request-1',
    reached: [{ limit: 'providerTurns', configured: 12, allowance: 12, observed: 12 }],
    limits: {
      coverage: 'complete', providerTurns: { ceiling: 12, observed: 12 },
      crossings: 1, allowances: 0, decision: 'awaiting', heldBoundary: 'provider-request',
    },
  };
  const WINDOW_MS = 15 * 60_000;
  const asking = (provider: ChatViewProvider, signal: AbortSignal) => askRequestLimitDecision(facts, signal, {
    openCard: (shown) => provider.openRequestLimitCard(shown),
    agentNames: () => ['PM', 'Senior Developer'],
    askedAgent: () => ({ id: 'pm', name: 'PM' }),
    windowMs: WINDOW_MS,
  });

  it('renders whatever the text function returns, and continues on the Continue click only', async () => {
    const expected = requestLimitPromptText(facts, ['PM', 'Senior Developer'], WINDOW_MS);
    for (const [action, decision] of [['continue', 'continue'], ['stop', 'stop'], ['always', 'stop']] as const) {
      const { provider } = chat();
      const answer = asking(provider, new AbortController().signal);
      const [pending] = pendingOf(provider);
      const [shown] = rendered(provider).cards;
      expect(shown.title).toBe(expected.message);
      expect(shown.lines.slice(1).map((line) => line.replace('appr-limit-line|', '')).join('\n\n')).toBe(expected.detail);

      click(provider, pending.id, action);
      expect(await answer, action).toBe(decision);
      expect(stateOf(provider).requestLimitOutcomes[0].settlement, action).toBe(decision === 'continue' ? 'continued' : 'stopped');
    }
  });

  it('settles the card at once for each reason the gate stops waiting, and never continues', async () => {
    const shownFor: Array<[unknown, string]> = [
      ['expired', 'expired'],
      ['withdrawn', 'withdrawn'],
      ['ended', 'ended'],
      ['disposed', 'ended'],
      // The gate of this branch gives no reason yet: nothing was decided.
      [undefined, 'withdrawn'],
      ['something else', 'withdrawn'],
    ];
    for (const [reason, settlement] of shownFor) {
      const { provider } = chat();
      const controller = new AbortController();
      const answer = asking(provider, controller.signal);
      const [pending] = pendingOf(provider);
      if (reason === undefined) controller.abort(); else controller.abort(reason);

      // In the abort itself: no open card and no action are left for a click to reach.
      expect(pendingOf(provider), String(reason)).toEqual([]);
      expect(stateOf(provider).requestLimitOutcomes.map((outcome: any) => outcome.settlement), String(reason)).toEqual([settlement]);
      expect(rendered(provider).cards[0].buttons, String(reason)).toEqual([]);
      click(provider, pending.id, 'continue');
      expect(await answer, String(reason)).toBe('stop');
    }
  });

  it('stops when the view cannot open a card', async () => {
    const { provider } = chat();
    provider.dispose();
    expect(await asking(provider, new AbortController().signal)).toBe('stop');
  });
});
