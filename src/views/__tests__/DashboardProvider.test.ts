import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { DashboardProvider, renderMissionControlLanes } from '../DashboardProvider';
import { SessionInfo } from '../../types';
import { WorktreeReview } from '../WorktreePanel';

/**
 * The fixed dependency fixture used to capture Dashboard's pre-shell body at 6feb05d.
 * Keep it independent of incidental live SessionManager state so a shell diff has one cause.
 */
function dashboardFixture(): DashboardProvider {
  return new DashboardProvider(
    {} as never,
    {
      getAll: () => [session()],
      getCostTimeline: () => [],
      getRecentTaskTokens: () => [],
    } as never,
    { getMessageCount: () => 0 } as never,
  );
}

function documentBody(html: string): string {
  const match = html.match(/<body>([\s\S]*)<\/body>/);
  if (!match) throw new Error('Dashboard renderer did not emit a body.');
  return match[1].replace(/nonce="[^"]+"/g, 'nonce="<nonce>"').replace(/[ \t]+(?=\r?\n)/g, '');
}

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'dev-1',
    status: 'running',
    restartCount: 0,
    currentTask: 'Implement the checkout flow and update tests',
    config: {
      id: 'dev-1',
      name: 'Senior Dev',
      role: 'senior-dev',
      skill: 'code-generation',
      provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
      model: 'deepseek-v4-pro',
      systemPrompt: 'Write code.',
      autoApprove: false,
      allowedTools: ['message'],
    },
    usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.42, turns: 1, costBasis: 'billed' },
    contextUsage: { tokens: 2048, window: 8192, ratio: 0.25, source: 'measured' },
    ...overrides,
  };
}

describe('Dashboard agent lanes', () => {
  it('uses distinct semantic theme tokens for working, done, and verification states', async () => {
    const html = await dashboardFixture().getDashboardHtml({ cspSource: 'test:' } as never);

    expect(html).toContain('.stat-running { color: var(--vscode-charts-green, var(--vscode-foreground)); }');
    expect(html).toContain('.lane-working .status-dot { background: var(--vscode-charts-green, var(--vscode-foreground)); }');
    expect(html).toContain('.lane-idle .status-dot { background: var(--vscode-charts-yellow, var(--vscode-foreground)); }');
    expect(html).toContain('.lane-done .status-dot { background: var(--vscode-charts-blue, #3b82f6); }');
    expect(html).toContain('.lane-blocked .status-dot, .lane-error .status-dot { background: var(--vscode-testing-iconFailed, #dc3545); }');
    expect(html).toContain('.lane-stopped .status-dot { background: var(--vscode-descriptionForeground, var(--vscode-foreground)); }');
    expect(html).toContain('.verify-passed { color: var(--vscode-charts-blue, #3b82f6);');
    expect(html).toContain('.verify-failed { color: var(--vscode-testing-iconFailed, #dc3545);');
    expect(html).toContain('.savings-banner.over .savings-head b { color: var(--vscode-editorWarning-foreground); }');
    // S1, 2026-09-04: `testing.iconPassed` shares one value across dark, light and hc-dark, so on the
    // default light theme it rendered a dark-theme green on white at 2.00:1. Nothing here may reach for it.
    expect(html).not.toContain('--vscode-testing-iconPassed');

    // The badge sits on .lane-board (input-background). A 13% fill of the text's own colour lightened that
    // ground past the 4.50 floor in Dark Modern, so the fill is 6% and the shape is a border.
    expect(html).toContain('.verify-badge { display: inline-flex; max-width: 100%; padding: 3px 8px; border: 1px solid transparent;');
    expect(html).toContain('.verify-passed { color: var(--vscode-charts-blue, #3b82f6); background: color-mix(in srgb, var(--vscode-charts-blue, #3b82f6) 6%, transparent); border-color: color-mix(in srgb, var(--vscode-charts-blue, #3b82f6) 40%, transparent); }');
    expect(html).toContain('.verify-failed { color: var(--vscode-testing-iconFailed, #dc3545); background: color-mix(in srgb, var(--vscode-testing-iconFailed, #dc3545) 6%, transparent); border-color: color-mix(in srgb, var(--vscode-testing-iconFailed, #dc3545) 40%, transparent); }');
    // The neutral pair takes no fill: their old editor-background fill matched the board in three of the
    // four bundled themes, so they had no shape at all there.
    expect(html).toContain('.verify-skipped, .verify-missing { color: var(--vscode-descriptionForeground); border-color: color-mix(in srgb, var(--vscode-descriptionForeground) 40%, transparent); }');
    expect(html).not.toContain('.verify-skipped, .verify-missing { color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); }');
  });

  it('keeps the body equal to the snapshot re-captured for the v0.9.87 section order', async () => {
    const html = await dashboardFixture().getDashboardHtml({ cspSource: 'test:' } as never);
    expect(documentBody(html)).toMatchSnapshot('body with latest tasks first (v0.9.87)');
  });

  it('puts Latest tasks first, then the team lanes, then totals, savings and charts', async () => {
    const body = documentBody(await dashboardFixture().getDashboardHtml({ cspSource: 'test:' } as never));
    const positions = ['<h3>Latest tasks', 'class="mission-header"', 'class="stats-grid"', 'class="panels"']
      .map((marker) => body.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('keeps Dashboard script-free under one shared CSP', async () => {
    const html = await dashboardFixture().getDashboardHtml({ cspSource: 'test:' } as never);
    const cspMeta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/g) ?? [];
    expect(cspMeta).toHaveLength(1);
    expect(cspMeta[0]).toContain("script-src 'none'");
    expect(html).not.toContain('<script');
  });

  it('renders status, task, files, cost, context, and command actions', () => {
    const html = renderMissionControlLanes([session()], {
      filesByAgent: new Map([['dev-1', ['src/cart.ts', 'test/cart.test.ts']]]),
    });

    expect(html).toContain('Senior Dev');
    expect(html).toContain('working');
    expect(html).toContain('Implement the checkout flow');
    expect(html).toContain('src/cart.ts, test/cart.test.ts');
    expect(html).toContain('$0.42');
    expect(html).toContain('25%');
    expect(html).toContain('command:unode.chatWithAgent?%5B%22dev-1%22%5D');
    expect(html).toContain('command:unode.showAgentTerminal?%5B%22dev-1%22%5D');
    expect(html).toContain('>New Task</a>');
  });

  it('uses delegation progress as the current lane task and escapes it', () => {
    const html = renderMissionControlLanes([session()], {
      agentStates: [{
        agentId: 'dev-1',
        status: 'blocked',
        task: 'Fix <script>alert(1)</script>',
        coordinatorName: 'PM',
        updatedAt: new Date().toISOString(),
      }],
    });

    expect(html).toContain('blocked');
    expect(html).toContain('Fix &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('shows waiting steps and turns quiet working state into a display-only stalled label', () => {
    const now = Date.now();
    const waiting = renderMissionControlLanes([session()], {
      agentStates: [{
        agentId: 'dev-1', status: 'working', task: 'Review the change', coordinatorName: 'PM',
        startedAt: new Date(now - 60_000).toISOString(), updatedAt: new Date(now - 1_000).toISOString(),
        stepCount: 3, waitingOn: 'model provider',
      }],
    });
    expect(waiting).toContain('Waiting on model provider · step 3 · 1 min');

    const stalled = renderMissionControlLanes([session()], {
      agentStates: [{
        agentId: 'dev-1', status: 'working', task: 'Review the change', coordinatorName: 'PM',
        startedAt: new Date(now - 5 * 60_000).toISOString(), updatedAt: new Date(now - 3 * 60_000).toISOString(),
        stepCount: 3,
      }],
    });
    expect(stalled).toContain('stalled');
    expect(stalled).toContain('no activity for 3 min');
    expect(stalled).not.toMatch(/Retry|Cancel/);
  });

  it('renders partial ahead of a done/evidence status', () => {
    const html = renderMissionControlLanes([session()], {
      agentStates: [{
        agentId: 'dev-1', status: 'verified', completionState: 'partial', task: 'Core done; checks remain',
        coordinatorName: 'PM', updatedAt: new Date().toISOString(),
      }],
    });
    expect(html).toContain('partial');
    expect(html).toContain('Core done; checks remain');
  });

  it('labels a lane cost as unknown until a completed turn establishes its billing basis', () => {
    const html = renderMissionControlLanes([session({
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0 },
    })]);
    expect(html).toContain('cost unknown');
    expect(html).not.toContain('$0.00');
  });

  it('shows worktree verification only when a worktree review is supplied', () => {
    const review: WorktreeReview = {
      base: 'main',
      integrationBranch: 'unode/integration',
      hasIntegration: true,
      lanes: [{
        agentId: 'dev-1',
        agent: 'Senior Dev',
        branch: 'unode/dev',
        path: 'C:/repo/.unode/worktrees/dev',
        verification: { status: 'passed', command: 'npm test', output: 'ok' },
        changedFiles: ['src/worktree-only.ts'],
      }],
      integrationFiles: ['src/worktree-only.ts'],
    };

    const withWorktree = renderMissionControlLanes([session()], { worktreeReview: review });
    expect(withWorktree).toContain('Verified / mergeable');
    expect(withWorktree).toContain('src/worktree-only.ts');

    const withoutWorktree = renderMissionControlLanes([session()]);
    expect(withoutWorktree).not.toContain('Verified / mergeable');
    expect(withoutWorktree).not.toContain('<div>Verified</div>');
  });

  it('associates worktree files and verification by agent id when display names match', () => {
    const base = session();
    const devA = session({
      id: 'dev-a',
      config: { ...base.config, id: 'dev-a', name: 'Developer' },
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.1, turns: 1 },
    });
    const devB = session({
      id: 'dev-b',
      config: { ...base.config, id: 'dev-b', name: 'Developer' },
      usage: { inputTokens: 20, outputTokens: 5, costUsd: 0.2, turns: 1 },
    });
    const review: WorktreeReview = {
      base: 'main',
      integrationBranch: 'unode/integration',
      hasIntegration: true,
      lanes: [
        {
          agentId: 'dev-a',
          agent: 'Developer',
          branch: 'unode/dev-a',
          path: 'C:/repo/.unode/worktrees/dev-a',
          verification: { status: 'passed', command: 'npm test', output: 'ok' },
          changedFiles: ['src/dev-a.ts'],
        },
        {
          agentId: 'dev-b',
          agent: 'Developer',
          branch: 'unode/dev-b',
          path: 'C:/repo/.unode/worktrees/dev-b',
          verification: { status: 'failed', command: 'npm test', output: 'nope' },
          changedFiles: ['src/dev-b.ts'],
        },
      ],
      integrationFiles: ['src/dev-a.ts', 'src/dev-b.ts'],
    };

    const html = renderMissionControlLanes([devA, devB], { worktreeReview: review });
    const aIndex = html.indexOf('src/dev-a.ts');
    const bIndex = html.indexOf('src/dev-b.ts');

    expect(aIndex).toBeGreaterThan(-1);
    expect(bIndex).toBeGreaterThan(-1);
    expect(html.indexOf('Verified / mergeable')).toBeGreaterThan(aIndex);
    expect(html.indexOf('Verified / mergeable')).toBeLessThan(bIndex);
    expect(html.indexOf('Failed / held')).toBeGreaterThan(bIndex);
  });

  it('renders a clean empty state', () => {
    const html = renderMissionControlLanes([]);
    expect(html).toContain('No agents configured yet.');
    expect(html).toContain('command:unode.createTeamPreset');
    expect(html).toContain('start using the Dashboard');
    expect(html).not.toContain('Mission Control');
  });
});
