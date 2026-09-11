import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ commands: { executeCommand: vi.fn() } }));

import * as vscode from 'vscode';
import { MessageBus } from '../../bus/MessageBus';
import { TeamViewProvider } from '../TeamViewProvider';

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
  approvalAttentionForAgent?: (agentId: string) => { state: 'waiting' | 'timed_out'; approvalId?: string; actionSummary?: string } | undefined,
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
    expect(html).toContain('Verified (V)');
    expect(html).toContain('Replied, not verified (↩)');
    expect(html).toContain('Consent required (🔒)');
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
