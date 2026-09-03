import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { DashboardProvider, renderMissionControlLanes } from '../DashboardProvider';
import { SessionInfo } from '../../types';
import { WorktreeReview } from '../WorktreePanel';

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
    const provider = new DashboardProvider(
      {} as never,
      {
        getAll: () => [session()],
        getCostTimeline: () => [],
        getRecentTaskTokens: () => [],
      } as never,
      { getMessageCount: () => 0 } as never,
    );

    const html = await provider.getDashboardHtml({ cspSource: 'test:' } as never);

    expect(html).toContain('.stat-running { color: var(--vscode-charts-green); }');
    expect(html).toContain('.lane-working .status-dot { background: var(--vscode-charts-green); }');
    expect(html).toContain('.lane-done .status-dot { background: var(--vscode-testing-iconPassed, #3fb950); }');
    expect(html).toContain('.lane-blocked .status-dot, .lane-error .status-dot { background: var(--vscode-testing-iconFailed, #dc3545); }');
    expect(html).toContain('.verify-passed { color: var(--vscode-testing-iconPassed, #3fb950);');
    expect(html).toContain('.verify-failed { color: var(--vscode-testing-iconFailed, #dc3545);');
    expect(html).toContain('.savings-banner.over .savings-head b { color: var(--vscode-editorWarning-foreground); }');
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
