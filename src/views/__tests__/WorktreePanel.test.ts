import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => {
  const panels: FakePanel[] = [];
  const window = {
    createWebviewPanel: vi.fn(() => {
      const panel = makePanel();
      panels.push(panel);
      return panel;
    }),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  };
  return { ViewColumn: { One: 1 }, window, panels };
});

vi.mock('vscode', () => vscodeMock);

import { renderHtml, WorktreePanel, WorktreeReview } from '../WorktreePanel';

const webview = { cspSource: 'test:' } as never;

interface FakePanel {
  webview: {
    cspSource: string;
    html: string;
    onDidReceiveMessage: ReturnType<typeof vi.fn>;
    messageHandler?: (msg: unknown) => void;
  };
  onDidDispose: ReturnType<typeof vi.fn>;
  reveal: ReturnType<typeof vi.fn>;
}

function makePanel(): FakePanel {
  const webview: FakePanel['webview'] = {
    cspSource: 'test:',
    html: '',
    onDidReceiveMessage: vi.fn((handler: (msg: unknown) => void) => {
      webview.messageHandler = handler;
      return { dispose: vi.fn() };
    }),
  };
  return {
    webview,
    onDidDispose: vi.fn(),
    reveal: vi.fn(),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  WorktreePanel.current = undefined;
  vscodeMock.panels.length = 0;
  vscodeMock.window.createWebviewPanel.mockClear();
  vscodeMock.window.showErrorMessage.mockClear();
  vscodeMock.window.showInformationMessage.mockClear();
  vscodeMock.window.showWarningMessage.mockClear();
});

describe('WorktreePanel review board', () => {
  it('renders failed lanes as held off integration with escaped expandable output', () => {
    const review: WorktreeReview = {
      base: 'main',
      integrationBranch: 'unode/integration',
      hasIntegration: false,
      lanes: [{
        agentId: 'dev-1',
        agent: 'Developer',
        branch: 'unode/dev',
        path: 'C:/repo/.worktrees/dev',
        verification: {
          status: 'failed',
          command: 'npm test',
          output: '<script>alert(1)</script>\nexpected & actual',
        },
      }],
      integrationFiles: [],
    };

    const html = renderHtml(webview, review);

    expect(html).toContain('✗');
    expect(html).toContain('Failing');
    expect(html).toContain('Held off integration until this lane verifies.');
    expect(html).toContain('<details class="verify-output" data-detail-id="verify-output:dev-1">');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('expected &amp; actual');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('failed lanes are held on their own branches until verification passes');
  });

  it('makes passed and unverified lane verification states prominent', () => {
    const review: WorktreeReview = {
      base: 'main',
      integrationBranch: 'unode/integration',
      hasIntegration: true,
      lanes: [
        {
          agentId: 'reviewer-1',
          agent: 'Reviewer',
          branch: 'unode/reviewer',
          path: 'C:/repo/.worktrees/reviewer',
          verification: { status: 'passed', command: 'npm test', output: 'ok' },
        },
        {
          agentId: 'designer-1',
          agent: 'Designer',
          branch: 'unode/designer',
          path: 'C:/repo/.worktrees/designer',
        },
      ],
      integrationFiles: ['src/app.ts'],
    };

    const html = renderHtml(webview, review);

    expect(html).toContain('✓');
    expect(html).toContain('Verified');
    expect(html).toContain('⚠');
    expect(html).toContain('Unverified');
    expect(html).toContain('No verification result yet. This lane has not been gated.');
  });

  it('flags a passing lane that modified tests as review-needed (anti-cheat)', () => {
    const review: WorktreeReview = {
      base: 'main',
      integrationBranch: 'unode/integration',
      hasIntegration: true,
      lanes: [{
        agentId: 'dev-1',
        agent: 'Developer',
        branch: 'unode/dev',
        path: 'C:/repo/.worktrees/dev',
        verification: { status: 'passed', command: 'npm test', output: 'ok', touchedTests: ['test/math.test.js'] },
      }],
      integrationFiles: ['src/math.js'],
    };

    const html = renderHtml(webview, review);

    expect(html).toContain('review tests');
    expect(html).toContain('also modified test files');
    expect(html).toContain('test/math.test.js');
    // It must NOT read as a clean pass.
    expect(html).not.toContain('<span class="vtext">Verified</span>');
  });

  it('renders changed files and lane action emitters with escaped file labels', () => {
    const review: WorktreeReview = {
      base: 'main',
      integrationBranch: 'unode/integration',
      hasIntegration: false,
      lanes: [{
        agentId: 'dev-1',
        agent: 'Developer',
        branch: 'unode/dev',
        path: 'C:/repo/.worktrees/dev',
        changedFiles: ['src/app.ts', 'src/<unsafe>.ts'],
        verification: { status: 'failed', command: 'npm test', output: 'nope' },
      }],
      integrationFiles: [],
    };

    const html = renderHtml(webview, review);

    expect(html).toContain('Changed files');
    expect(html).toContain('data-lane-command="openLaneDiff"');
    expect(html).toContain('data-agent-id="dev-1"');
    expect(html).not.toContain('data-agent="Developer"');
    expect(html).toContain('data-file="src/app.ts"');
    expect(html).toContain('src/&lt;unsafe&gt;.ts');
    expect(html).not.toContain('src/<unsafe>.ts');
    expect(html).toContain('View diff');
    expect(html).toContain('Re-verify');
    expect(html).toContain('Hand back');
    expect(html).toContain('data-lane-command="reverifyLane"');
    expect(html).toContain('data-lane-command="handBackLane"');
  });

  it('routes lane messages to the optional lane action handler', async () => {
    const actions: unknown[] = [];
    WorktreePanel.createOrShow(
      {} as never,
      async () => ({ base: 'main', integrationBranch: 'unode/integration', hasIntegration: false, lanes: [], integrationFiles: [] }),
      async () => ({ ok: true, message: 'done' }),
      (action) => { actions.push(action); }
    );
    await flush();
    const handler = vscodeMock.panels[0].webview.messageHandler!;

    handler({ command: 'openLaneDiff', agentId: 'dev-1', file: 'src/app.ts' });
    handler({ command: 'openLaneDiff', agentId: 'dev-1' });
    handler({ command: 'reverifyLane', agentId: 'dev-1' });
    handler({ command: 'handBackLane', agentId: 'dev-1' });
    handler({ command: 'handBackLane' });

    expect(actions).toEqual([
      { command: 'openLaneDiff', agentId: 'dev-1', file: 'src/app.ts' },
      { command: 'openLaneDiff', agentId: 'dev-1' },
      { command: 'reverifyLane', agentId: 'dev-1' },
      { command: 'handBackLane', agentId: 'dev-1' },
    ]);
  });

  it('keeps same-named lane actions keyed by agent id', async () => {
    const actions: unknown[] = [];
    WorktreePanel.createOrShow(
      {} as never,
      async () => ({
        base: 'main',
        integrationBranch: 'unode/integration',
        hasIntegration: false,
        lanes: [
          { agentId: 'dev-a', agent: 'Developer', branch: 'unode/dev-a', path: 'C:/repo/.worktrees/dev-a' },
          { agentId: 'dev-b', agent: 'Developer', branch: 'unode/dev-b', path: 'C:/repo/.worktrees/dev-b' },
        ],
        integrationFiles: [],
      }),
      async () => ({ ok: true, message: 'done' }),
      (action) => { actions.push(action); }
    );
    await flush();

    const html = vscodeMock.panels[0].webview.html;
    expect(html).toContain('data-agent-id="dev-a"');
    expect(html).toContain('data-agent-id="dev-b"');
    expect(html).not.toContain('data-agent="Developer"');

    vscodeMock.panels[0].webview.messageHandler!({ command: 'openLaneDiff', agentId: 'dev-b' });

    expect(actions).toEqual([{ command: 'openLaneDiff', agentId: 'dev-b' }]);
  });

  it('updates the current panel from a pushed review without recreating it', async () => {
    WorktreePanel.createOrShow(
      {} as never,
      async () => ({
        base: 'main',
        integrationBranch: 'unode/integration',
        hasIntegration: false,
        lanes: [{ agentId: 'dev-1', agent: 'Developer', branch: 'unode/dev', path: 'C:/repo/.worktrees/dev' }],
        integrationFiles: [],
      }),
      async () => ({ ok: true, message: 'done' })
    );
    await flush();
    expect(vscodeMock.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(vscodeMock.panels[0].webview.html).toContain('Developer');

    WorktreePanel.current!.update({
      base: 'main',
      integrationBranch: 'unode/integration',
      hasIntegration: true,
      lanes: [{ agentId: 'reviewer-1', agent: 'Reviewer', branch: 'unode/reviewer', path: 'C:/repo/.worktrees/reviewer', changedFiles: ['src/review.ts'] }],
      integrationFiles: ['src/review.ts'],
    });

    expect(vscodeMock.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(vscodeMock.panels[0].webview.html).toContain('Reviewer');
    expect(vscodeMock.panels[0].webview.html).toContain('src/review.ts');
    expect(vscodeMock.panels[0].webview.html).not.toContain('Developer');
  });
});
