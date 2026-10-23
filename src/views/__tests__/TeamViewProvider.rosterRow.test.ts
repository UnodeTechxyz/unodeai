import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ commands: { executeCommand: vi.fn() } }));

import * as vscode from 'vscode';
import { MessageBus } from '../../bus/MessageBus';
import { RECENT_DELEGATION_STATUS_MS, TeamViewProvider } from '../TeamViewProvider';

const SESSION = {
  id: 'agent-1',
  status: 'running',
  restartCount: 0,
  currentTask: 'fix the auth middleware',
  contextUsage: { ratio: 0.41 },
  usage: { costUsd: 0.182, costBasis: 'api', turns: 12, inputTokens: 1000, outputTokens: 500 },
  config: {
    id: 'agent-1',
    name: 'Backend Dev',
    role: 'developer',
    model: 'claude-sonnet-5',
    provider: { providerId: 'claude-code' },
    systemPrompt: '',
    skills: [{ name: 'api' }, { name: 'database' }],
  },
};

function makeProvider(
  session: Record<string, unknown> = SESSION,
  commandNarrowingSummary?: (config: any) => string | undefined,
  approvalAttentionForAgent?: (agentId: string) => { state: 'waiting' | 'timed_out'; approvalId?: string; actionSummary?: string; kind?: 'command' | 'request-limit' } | undefined,
) {
  const sessionManager = {
    getAll: () => [session],
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    remove: vi.fn(),
  };
  const provider = new TeamViewProvider(
    {} as never,
    sessionManager as never,
    new MessageBus(),
    '',
    undefined,
    () => [],
    (providerId) => providerId === 'claude-code' ? 'Claude Code' : providerId,
    approvalAttentionForAgent,
    commandNarrowingSummary,
  );
  return { provider, sessionManager };
}

function resolve(provider: TeamViewProvider) {
  const handlers: Array<(msg: unknown) => void> = [];
  const view = {
    webview: {
      cspSource: 'test:',
      options: {},
      html: '',
      onDidReceiveMessage: (cb: (msg: unknown) => void) => { handlers.push(cb); },
    },
  };
  provider.resolveWebviewView(view as never, {} as never, {} as never);
  return { html: () => view.webview.html as string, post: (msg: unknown) => handlers.forEach((cb) => cb(msg)) };
}

describe('TeamViewProvider roster row', () => {
  beforeEach(() => {
    vi.mocked(vscode.commands.executeCommand).mockClear();
  });

  it('keeps every member fact and control reachable from its row', () => {
    const { provider } = makeProvider();
    const html = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });

    // Row: navigation + status.
    expect(html).toContain('class="session-name">Backend Dev<');
    expect(html).toContain('data-command="chatAgent"');
    // Detail: the facts that used to live on the agent card.
    expect(html).toContain('Model: claude-sonnet-5');
    expect(html).toContain('Provider: Claude Code');
    expect(html).toContain('class="skill-tag">api<');
    expect(html).toContain('$0.18');
    expect(html).toContain('12 turns');
    // Controls: status control + the per-agent configure page.
    expect(html).toContain('data-command="stopAgent"');
    expect(html).toContain('data-command="restartAgent"');
    expect(html).toContain('data-command="editAgent"');
    expect(html).toContain('data-command="showTerminal"');
    expect(html).toContain('data-expand');
    // One Configure affordance per row, not two: the ⚙️ icon is it. An expanded row shows its controls
    // unconditionally, so the icon does not depend on hover once the detail is open.
    expect(html.match(/data-command="editAgent"/g)).toHaveLength(1);
    expect(html).not.toContain('Configure this agent');
  });

  it('renders partial ahead of a verified status or coordinator disposition', () => {
    const { provider } = makeProvider();
    provider.setDelegationProgress([{
      agentId: 'agent-1', status: 'verified', completionState: 'partial',
      task: 'finish the integration checks', coordinatorName: 'PM', updatedAt: new Date().toISOString(),
    }]);
    const html = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
    expect(html).toContain('Partial');
    expect(html).toContain('unfinished finish the integration checks');
  });

  it('keeps the interrupted state and its durable facts visible after replacement', () => {
    const { provider } = makeProvider();
    provider.setDelegationProgress([{
      agentId: 'agent-1', status: 'interrupted',
      task: 'Reason: host-restarted. Last observed: 2026-09-11T13:01:00.000Z. Detected: 2026-09-11T13:02:00.000Z. Coordinator superseded task: Replacement admitted. Replacement: replacement-handle.',
      coordinatorName: 'PM', updatedAt: new Date().toISOString(),
    }]);
    const html = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
    expect(html).toContain('Interrupted');
    expect(html).toContain('Reason: host-restarted. Last observed: 2026-09-11T13:01:00.000Z. Detected: 2026-09-11T13:02:00.000Z.');
    expect(html).toContain('Replacement: replacement-handle.');
  });

  it('keeps the controls on screen instead of hiding them behind a hover', () => {
    const { provider } = makeProvider();
    const html = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });

    // Controls that appear only on :hover blink out whenever the pointer leaves the row.
    expect(html).toContain('.session-actions { display: inline-flex; gap: 1px; }');
    expect(html).not.toMatch(/\.session-item:hover \.session-actions/);

    // The status word is gone; the glyph carries the lifecycle and the dot carries what it cannot.
    expect(html).not.toContain('class="session-status');
    // A running agent WITH a task reports as 'working' — the dot follows the presented state, not the
    // raw lifecycle field, so the two cannot drift apart.
    expect(html).toContain('class="session-item status-working');
    expect(html).toContain('<span class="status-dot" aria-hidden="true"></span>');
    // The accessible name states it outright. `title` is a tooltip: its screen-reader treatment is
    // inconsistent and it never reaches a keyboard-only or touch user, so it cannot be the mitigation
    // for dropping the visible word.
    // The label must repeat the row's OWN visible words: aria-label replaces the accessible name that
    // would otherwise be computed from the button's contents, so anything it omits is not merely
    // unlabelled — it is erased for a screen reader.
    expect(html).toContain('aria-label="Backend Dev, Working, on fix the auth middleware"');
    expect(html).toContain('Backend Dev — Working');
    expect(html).toContain('class="status-marker status-working"');
    expect(html).toContain('<summary>Status key</summary>');
    expect(html).toContain('Done (✓)');
    expect(html).toContain('Task checks passed (V)');
    expect(html).toContain('Replied, not verified (↩)');
    expect(html).toContain('Consent required (🔒)');
  });

  // Field run F1: the manual promised the roster opens Smart compaction directly, but only a general Configure existed.
  it('opens Agent Builder on the agent\'s Smart compaction group from its own row button, running or stopped', () => {
    for (const status of ['running', 'stopped']) {
      const { provider } = makeProvider({ ...SESSION, status });
      const { html, post } = resolve(provider);
      expect(html()).toContain('data-command="editSmartCompaction" data-agent-id="agent-1" title="Smart compaction" aria-label="Smart compaction"');
      vi.mocked(vscode.commands.executeCommand).mockClear();
      post({ command: 'editSmartCompaction', agentId: 'agent-1' });
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('unode.openAgentBuilder', { agentId: 'agent-1', focus: 'smart-compaction' });
    }
  });

  it('offers start and remove once the agent is stopped', () => {
    const { provider } = makeProvider({ ...SESSION, status: 'stopped' });
    const html = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
    expect(html).toContain('data-command="startAgent"');
    expect(html).toContain('data-command="removeAgent"');
    expect(html).not.toContain('data-command="stopAgent"');
  });

  it('routes every rendered data-command to a host action — no dead buttons', () => {
    const { provider, sessionManager } = makeProvider();
    const { html, post } = resolve(provider);
    const rendered = [...new Set([...html().matchAll(/data-command="([a-zA-Z]+)"/g)].map((m) => m[1]))];
    expect(rendered.length).toBeGreaterThan(4);

    for (const command of rendered) {
      vi.mocked(vscode.commands.executeCommand).mockClear();
      sessionManager.start.mockClear();
      sessionManager.stop.mockClear();
      sessionManager.restart.mockClear();
      sessionManager.remove.mockClear();
      post({ command, agentId: 'agent-1' });
      const handled = vi.mocked(vscode.commands.executeCommand).mock.calls.length > 0
        || sessionManager.start.mock.calls.length > 0
        || sessionManager.stop.mock.calls.length > 0
        || sessionManager.restart.mock.calls.length > 0
        || sessionManager.remove.mock.calls.length > 0;
      expect(handled, `"${command}" is rendered but the host ignores it`).toBe(true);
    }
  });

  it('treats a roster double-click as an explicit Workbench request, except when approval needs focus', () => {
    const { provider } = makeProvider();
    const { html, post } = resolve(provider);

    expect(html()).toContain("document.addEventListener('dblclick'");
    expect(html()).toContain("item.classList.contains('status-consent-required') ? 'focusApproval' : 'openAgentWorkbench'");

    post({ command: 'openAgentWorkbench', agentId: 'agent-1' });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('unode.openAgentWorkbench', 'agent-1');

    vi.mocked(vscode.commands.executeCommand).mockClear();
    post({ command: 'focusApproval', agentId: 'agent-1' });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('unode.focusPendingApproval', 'agent-1');
  });

  it('handles the Security message that the removed setup subpanel used to send', () => {
    const { provider } = makeProvider();
    const { post } = resolve(provider);
    post({ command: 'showSecurity' });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('unode.showSecurity');
  });

  it('drops the setup subpanel that duplicated the title-bar icons', () => {
    const { provider } = makeProvider();
    const html = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
    expect(html).not.toContain('Connections &amp; setup');
    expect(html).not.toContain('sidebar-secondary');
  });

  /**
   * The panel renders no entrance button at all now. It had one, on a row of its own, in a sidebar that
   * holds three views — and the control it offered is a pinned title-bar icon, where it costs no vertical
   * space (Owner, 2026-08-21). Both message routes stay registered: callers outside the rendered view use
   * them, and removing a handler because its button is gone is how a working caller breaks silently.
   */
  it('renders no entrance button, and still answers both legacy message routes', () => {
    const { provider } = makeProvider();
    const { html, post } = resolve(provider);

    expect(html()).not.toContain('data-command="newTask"');
    expect(html()).not.toContain('data-command="openWorkbench"');

    for (const command of ['openWorkbench', 'newTask']) {
      (vscode.commands.executeCommand as ReturnType<typeof vi.fn>).mockClear();
      post({ command });
      expect(vscode.commands.executeCommand, command).toHaveBeenCalledWith('unode.openWorkbench');
    }
  });

  it('says Decision needed for an agent that is in a turn, once the panel is drawn again', () => {
    // Field run of 2026-10-10: a limit card had been open for three minutes, held at the coordinator's dispatch
    // inside its turn, and the coordinator's row still said Working. The row is drawn from the approval that is
    // pending for the agent, and while the agent's status stays `running` nothing else draws the panel again.
    let pending: { state: 'waiting'; kind: 'request-limit'; actionSummary: string } | undefined;
    const { provider } = makeProvider({ ...SESSION, status: 'running' }, undefined, () => pending);
    const row = (): string => {
      const html = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
      return html.slice(html.lastIndexOf('</style>'));
    };

    expect(row()).not.toContain('Decision needed');
    pending = { state: 'waiting', kind: 'request-limit', actionSummary: 'A request reached the limit you set' };
    expect(row()).toContain('Decision needed');
    pending = undefined;
    expect(row()).not.toContain('Decision needed');

    // So every approval event draws the panel again, beside the status bar's count.
    const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
    expect(source).toContain(
      '  context.subscriptions.push(chatViewProvider.onApprovalEvent(() => {\n'
      + '    updateStatusBar();\n'
      + '    teamViewProvider?.refresh();\n'
      + '  }));\n',
    );
  });
});

// UX7 row 9: "`consent_required` renders distinctly on every surface (test, not inspection)." The chat
// surfaces were covered; the Team panel was the one rendering it with nothing asserting it. The roster is
// where a user scanning the crew notices an agent is stuck — a consent that reads as a generic idle state
// there is a decision nobody goes looking for.
describe('TeamViewProvider — consent_required is distinct on the roster (UX7 row 9)', () => {
  beforeEach(() => {
    vi.mocked(vscode.commands.executeCommand).mockClear();
  });

  it('gives a consent_required agent its own status class and wording, not idle or error', () => {
    const consentSession = { ...SESSION, status: 'consent_required' };
    const { provider } = makeProvider(consentSession);
    const html = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
    // Assert on the rendered body only. The stylesheet declares every status class, so a whole-document
    // match would pass no matter which one the row actually got — the exact false positive this row exists
    // to prevent.
    const body = html.slice(html.lastIndexOf('</style>'));

    // The dedicated class is what carries the amber dot; without it the row is visually an ordinary agent.
    expect(body).toContain('status-consent-required');
    // And it must not be dressed as either of the two states it is easiest to be mistaken for.
    expect(body).not.toContain('status-idle');
    expect(body).not.toContain('status-error');
    expect(body).toContain('status-marker status-consent-required');
    expect(body).toContain('>🔒</span>');
  });

  // v0.9.97 L0 (DESIGN_v0997 review resolution, section 6): "只有实际停止证据才能显示 stopped，否则 stop-unconfirmed".
  it('shows a stopped agent as Stopping until its stop is seen, and as Stop unconfirmed when it is not, never as Stopped', () => {
    const body = (session: Record<string, unknown>) => {
      const { provider } = makeProvider(session);
      const html = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
      return html.slice(html.lastIndexOf('</style>'));
    };
    const stopping = body({ ...SESSION, status: 'stopped', stopEvidence: { state: 'stopping' } });
    expect(stopping).toContain('status-marker status-stopping');
    expect(stopping).not.toContain('status-marker status-stopped');

    const unconfirmed = body({ ...SESSION, status: 'error', stopEvidence: { state: 'unconfirmed', detail: 'process 4242 was still running' } });
    expect(unconfirmed).toContain('status-marker status-stop-unconfirmed');
    expect(unconfirmed).toContain('Stop unconfirmed');
    expect(unconfirmed).toContain('process 4242 was still running');
    expect(unconfirmed).not.toContain('status-marker status-stopped');

    expect(body({ ...SESSION, status: 'stopped' })).toContain('status-marker status-stopped');
  });

  it('gives Done and Verified distinct non-colour markers in the rendered roster body', () => {
    const { provider } = makeProvider();
    provider.setDelegationProgress([{ agentId: 'agent-1', status: 'done', updatedAt: new Date().toISOString(), task: 'implement' }] as never);
    const doneHtml = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
    const doneBody = doneHtml.slice(doneHtml.lastIndexOf('</style>'));
    expect(doneBody).toContain('status-marker status-done');
    expect(doneBody).toContain('>✓</span>');

    provider.setDelegationProgress([{ agentId: 'agent-1', status: 'verified', updatedAt: new Date().toISOString(), task: 'implement' }] as never);
    const verifiedHtml = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
    const verifiedBody = verifiedHtml.slice(verifiedHtml.lastIndexOf('</style>'));
    expect(verifiedBody).toContain('status-marker status-verified');
    expect(verifiedBody).toContain('>V</span>');
  });

  it('renders a consent expiry from the approval lifecycle with the documented clock marker', () => {
    const { provider } = makeProvider(SESSION, undefined, () => ({ state: 'timed_out' }));
    const html = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
    const body = html.slice(html.lastIndexOf('</style>'));

    expect(body).toContain('status-marker status-consent-timed-out');
    expect(body).toContain('>⌛</span>');
    expect(body).toContain('Denied — timed out');
    expect(body).not.toContain('status-delegation-timed-out');
  });

  // v0.9.94: a reached request limit asks for a decision about the request. It is not a permission.
  it('calls a waiting request limit decision a decision, and a waiting approval an approval', () => {
    const rowFor = (attention: { state: 'waiting'; actionSummary?: string; kind?: 'command' | 'request-limit' }): string => {
      const { provider } = makeProvider(SESSION, undefined, () => attention);
      const html = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
      return html.slice(html.lastIndexOf('</style>'));
    };

    const decision = rowFor({ state: 'waiting', kind: 'request-limit', actionSummary: 'A request reached the limit you set' });
    expect(decision).toContain('Decision needed');
    expect(decision).toContain('A request reached the limit you set');
    expect(decision).not.toContain('Approval needed');
    expect(rowFor({ state: 'waiting', kind: 'request-limit' })).toContain('Waiting for your decision');

    const approval = rowFor({ state: 'waiting', kind: 'command', actionSummary: 'npm test' });
    expect(approval).toContain('Approval needed');
    expect(approval).not.toContain('Decision needed');
    expect(rowFor({ state: 'waiting' })).toContain('Approval needed');
  });

  it('keeps a delegated task timeout distinct from a consent expiry marker', () => {
    const { provider } = makeProvider();
    provider.setDelegationProgress([{
      agentId: 'agent-1', status: 'timed-out', updatedAt: new Date().toISOString(), task: 'run checks',
    }] as never);
    const html = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
    const body = html.slice(html.lastIndexOf('</style>'));

    expect(body).toContain('status-marker status-delegation-timed-out');
    expect(body).toContain('>!</span>');
    expect(body).toContain('Timed out');
    expect(body).not.toContain('status-consent-timed-out');
  });

  it('renders a coordinator-rejected delegation as a visibly amended Team-card status', () => {
    const { provider } = makeProvider();
    provider.setDelegationProgress([{
      agentId: 'agent-1', status: 'coordinator-rejected', updatedAt: new Date().toISOString(),
      task: 'Amended from verified: The acceptance table is missing.',
    }] as never);
    const html = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
    const body = html.slice(html.lastIndexOf('</style>'));

    expect(body).toContain('status-marker status-coordinator-rejected');
    expect(body).toContain('Coordinator rejected — amended');
    expect(body).toContain('The acceptance table is missing.');
  });

  it('shows the one command summary only for an agent with a narrowing', () => {
    const narrowedSession = {
      ...SESSION,
      config: {
        ...SESSION.config,
        commandNarrowing: { approvalMode: 'allowlist', allowedCommands: ['npm test', 'git status'] },
      },
    };
    const { provider } = makeProvider(narrowedSession, () => 'Commands: narrowed (2 of 5)');
    const body = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
    expect(body).toContain('Commands: narrowed (2 of 5)');

    const inherited = makeProvider();
    const inheritedBody = (inherited.provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
    expect(inheritedBody).not.toContain('Commands: narrowed');
  });

  it('stops the roster pulse when the operating system requests reduced motion', () => {
    const { provider } = makeProvider();
    const html = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
    expect(html).toContain('@media (prefers-reduced-motion: reduce)');
    expect(html).toContain('.compact-card.status-working .status-dot');
    expect(html).toContain('animation: none;');
  });
});

// Field test 2026-09-26: a "Coordinator accepted" row stayed green long after its two minutes, and turned into the
// session state only when a click happened to redraw the roster. The expiry itself now redraws it.
describe('TeamViewProvider settled-result label expiry', () => {
  it('redraws the roster when a settled result label expires, so it never lingers until the next click', () => {
    vi.useFakeTimers();
    try {
      const { provider } = makeProvider();
      const view = { webview: { html: '', options: {}, onDidReceiveMessage: vi.fn(() => ({ dispose() {} })) }, onDidChangeVisibility: vi.fn(() => ({ dispose() {} })), onDidDispose: vi.fn(() => ({ dispose() {} })), visible: true };
      (provider as unknown as { _view: unknown })._view = view;
      provider.setDelegationProgress([{
        agentId: 'agent-1', status: 'coordinator-accepted', task: 'notes.txt', coordinatorName: 'PM', updatedAt: new Date().toISOString(),
      }] as never);
      const body = () => view.webview.html.slice(view.webview.html.lastIndexOf('</style>'));
      expect(body()).toContain('status-coordinator-accepted');

      vi.advanceTimersByTime(RECENT_DELEGATION_STATUS_MS - 1_000);
      expect(body()).toContain('status-coordinator-accepted');
      vi.advanceTimersByTime(2_000);
      expect(body()).not.toContain('status-coordinator-accepted');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TeamViewProvider over-target badge (v0.9.89 field round 5)', () => {
  it('never claims work is continuing in its tooltip; only the badge text says so, while it is true', () => {
    const sessionManager = { getAll: () => [{ ...SESSION, status: 'idle' }] };
    const provider = new TeamViewProvider(
      {} as never, sessionManager as never, new MessageBus(), '', undefined, () => [], (id) => id,
      undefined, undefined, undefined,
      () => ({ overTarget: true, badgeText: 'Over spend target (311%)', perAgent: {} }),
    );
    const html = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
    const badge = html.match(/<button class="spend-badge"[^>]*>[^<]*<\/button>/)?.[0] ?? '';
    expect(badge).toContain('Over spend target (311%)');
    expect(badge).toContain('title="A spend reminder target is exceeded. Reminders never stop work. Click to open Spend."');
    expect(badge.toLowerCase()).not.toContain('work is continuing');
  });
});

describe('TeamViewProvider member metadata strip (v0.9.93)', () => {
  function render(
    reasoningEffort?: (config: any) => { label: string; basis: string } | undefined,
    session: Record<string, unknown> = SESSION,
  ): string {
    const provider = new TeamViewProvider(
      {} as never, { getAll: () => [session] } as never, new MessageBus(), '', undefined, () => [],
      (providerId) => providerId === 'claude-code' ? 'Claude Code' : providerId,
      undefined, undefined, undefined, undefined, reasoningEffort,
    );
    return (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
  }
  const strip = (html: string): string => /<span class="member-meta"[\s\S]*?<\/span><\/span>/.exec(html)?.[0] ?? '';
  const cells = (html: string): string[] => [...strip(html).matchAll(/<span class="meta-cell[^"]*"[^>]*>([^<]*)<\/span>/g)].map((match) => match[1]);

  it('shows Provider, Role, Status and Reasoning effort as one group, in that order', () => {
    const html = render(() => ({ label: 'High', basis: 'Set on this agent.' }));
    expect(html.match(/class="member-meta"/g)).toHaveLength(1);
    expect(cells(html)).toEqual(['Provider: Claude Code', 'Role: developer', 'Status: 🏃 Working', 'Reasoning: High']);
    // The short word is what is shown; the title and the accessible name keep the full one.
    expect(strip(html)).toContain('title="Reasoning effort: High. Set on this agent." aria-label="Reasoning effort: High">Reasoning: High</span>');
    expect(strip(html)).toContain('role="group" aria-label="Provider, role, status and reasoning effort"');
    // The product name, not the wire key.
    expect(html).not.toContain('reasoning_effort');
    expect(html).not.toMatch(/Reasoning effect/i);
    // The three facts are no longer rows of their own beside the strip.
    expect(html.match(/Provider: Claude Code</g)).toHaveLength(1);
    expect(html.match(/>Role: developer</g)).toHaveLength(1);
    expect(html.match(/Status: /g)).toHaveLength(1);
  });

  it('renders the strip as two rows of two, and as one row only when the card is wide enough', () => {
    const html = render(() => ({ label: 'High', basis: 'Set on this agent.' }));
    // Narrow by default: two columns, so four facts make two balanced rows and never four.
    expect(html).toContain('.member-meta { display: grid; grid-template-columns: repeat(2, minmax(0, auto));');
    // Wide: the member's own card is the measure, not the window.
    expect(html).toContain('.session-detail .agent-details { display: grid; gap: 3px; margin-bottom: 6px; container-type: inline-size; }');
    expect(html).toMatch(/@container \(min-width: 520px\) \{\s*\.member-meta \{ grid-template-columns: repeat\(4, minmax\(0, auto\)\); \}\s*\}/);
  });

  it('may clip a long provider or role and keeps the whole value in its title; status and effort are never clipped', () => {
    const html = render(() => ({ label: 'Provider default', basis: 'Not set, so none is sent and the provider decides.' }), {
      ...SESSION,
      config: { ...SESSION.config, role: 'Image and Video Editor', provider: { providerId: 'custom:aaaaaaaaaaaaaaaa' } },
    });
    const group = strip(html);
    expect(group).toContain('<span class="meta-cell meta-clip" title="Provider: custom:aaaaaaaaaaaaaaaa">Provider: custom:aaaaaaaaaaaaaaaa</span>');
    expect(group).toContain('<span class="meta-cell meta-clip" title="Role: Image and Video Editor">Role: Image and Video Editor</span>');
    expect(group).toMatch(/<span class="meta-cell">Status: /);
    expect(group).toContain('<span class="meta-cell" title="Reasoning effort: Provider default. Not set, so none is sent and the provider decides." aria-label="Reasoning effort: Provider default">Reasoning: Provider default</span>');
    expect(html).toContain('.meta-clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }');
    // A named gateway shows its name; the opaque id is in the title only, and not in parentheses.
    const named = render(undefined, { ...SESSION, config: { ...SESSION.config, provider: { providerId: 'claude-code' } } });
    expect(strip(named)).toContain('title="Provider: Claude Code · claude-code">Provider: Claude Code</span>');
  });

  it('renders what the host resolved and nothing of its own: Not supported, a default, or no cell at all', () => {
    const saved = { ...SESSION, config: { ...SESSION.config, modelParams: { reasoning_effort: 'high' } } };
    // The route filters the field: the saved value is not shown as if it were used.
    const unsupported = render(() => ({ label: 'Not supported', basis: 'This route does not take a reasoning effort, so none is sent.' }), saved);
    expect(cells(unsupported).at(-1)).toBe('Reasoning: Not supported');
    expect(strip(unsupported)).not.toContain('High');
    expect(cells(render(() => ({ label: 'Medium', basis: 'Not set on this agent, so the global default applies.' }))).at(-1))
      .toBe('Reasoning: Medium');
    // Without a resolver the view does not guess from the saved value.
    const unwired = render(undefined, saved);
    expect(cells(unwired)).toEqual(['Provider: Claude Code', 'Role: developer', 'Status: 🏃 Working']);
    expect(strip(unwired)).not.toMatch(/reasoning effort/i);
    expect(strip(unwired)).toContain('aria-label="Provider, role and status"');
  });

  it('keeps a status detail visible below the strip, where it does not stretch the row', () => {
    const provider = new TeamViewProvider(
      {} as never, { getAll: () => [SESSION] } as never, new MessageBus(), '', undefined, () => [],
      (providerId) => providerId, undefined, undefined, undefined, undefined,
      () => ({ label: 'High', basis: 'Set on this agent.' }),
    );
    provider.setDelegationProgress([{
      agentId: 'agent-1', status: 'interrupted', task: 'Reason: host-restarted.', coordinatorName: 'PM',
      updatedAt: new Date().toISOString(),
    }]);
    const html = (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
    expect(cells(html)[2]).toMatch(/^Status: \S+ Interrupted$/);
    expect(html).toContain('<span class="status-detail">Reason: host-restarted.</span>');
  });
});

describe('TeamViewProvider roster width (v0.9.97)', () => {
  const LONG_PATH = 'PolyFlow WhitePaper/drafts/2026-10/PolyFlow_NeoBanking_Infrastructure_core_capabilities_final_v3.md';

  function render(): string {
    const provider = new TeamViewProvider(
      {} as never, { getAll: () => [SESSION] } as never, new MessageBus(), '', undefined,
      () => [{ id: 7, ts: 1, agentId: 'agent-1', path: LONG_PATH }] as never,
      (providerId) => providerId === 'claude-code' ? 'Claude Code' : providerId,
    );
    return (provider as unknown as { _getHtml: (w: unknown) => string })._getHtml({ cspSource: 'test:' });
  }

  it('keeps the roster as wide as the view, so a long changed-file path cannot push the row controls out', () => {
    const html = render();
    // One column of the view's width. A content-sized column grew to the longest unbreakable path of any
    // member, and every row's controls moved past the sidebar's edge with it (the Owner's report, 2026-10-19).
    expect(html).toContain('#team-container:not(.compact-grid) { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }');
    // The path is clipped in its own row, and the whole path stays in its title.
    expect(html).toContain(`title="${LONG_PATH}">📝 ${LONG_PATH}</button>`);
    expect(html).toMatch(/\.file-activity-item \{ width: 100%;[^}]*white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/);
  });

  it("puts the row controls right after the member's own name, and keeps the expand toggle at the far edge", () => {
    const html = render();
    // Columns: avatar, name, controls, free space, expand (the Owner's choice, 2026-10-19).
    expect(html).toMatch(/\.session-row \{ display: grid; grid-template-columns: auto minmax\(0, max-content\) auto minmax\(0, 1fr\) auto;\s+grid-template-rows: auto auto;/);
    // The open button lays its parts on the row's own columns, so only the name sizes the name column: a long
    // task line spans the columns after it and cannot move the controls.
    expect(html).toMatch(/\.session-open \{ grid-column: 1 \/ -1; grid-row: 1 \/ -1; display: grid; grid-template-columns: subgrid;\s+grid-template-rows: subgrid;/);
    expect(html).toContain('.session-main { display: contents; }');
    expect(html).toMatch(/\.session-name \{ grid-column: 2; grid-row: 1; min-width: 0;/);
    expect(html).toMatch(/\.session-task \{ grid-column: 2 \/ -1; grid-row: 2; min-width: 0;/);
    // The controls and the toggle are drawn over the open button, which spans their cells too.
    expect(html).toMatch(/\.session-trail \{ grid-column: 3; grid-row: 1; position: relative; z-index: 1;/);
    expect(html).toMatch(/\.session-expand \{ grid-column: 5; grid-row: 1; position: relative; z-index: 1;/);
    // They stay siblings after the open button, never inside it: a button cannot contain buttons.
    const row = /<div class="session-row">[\s\S]*?data-expand/.exec(html)?.[0] ?? '';
    const openEnds = row.indexOf('</button>');
    expect(openEnds).toBeGreaterThan(row.indexOf('class="session-open"'));
    expect(row.indexOf('class="session-trail"')).toBeGreaterThan(openEnds);
  });
});
