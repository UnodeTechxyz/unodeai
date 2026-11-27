import { describe, expect, it } from 'vitest';
import { AgentConfig, SessionInfo, SessionStatus } from '../../types';
import { toConsoleRows } from '../parallelConsoleModel';

function session(overrides: Partial<SessionInfo> = {}, configOverrides: Partial<AgentConfig> = {}): SessionInfo {
  const config: AgentConfig = {
    id: 'dev',
    name: 'Dev',
    role: 'developer',
    skill: 'development',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'test-model',
    systemPrompt: 'Build things.',
    autoApprove: false,
    allowedTools: [],
    ...configOverrides,
  };

  return {
    id: config.id,
    config,
    status: 'idle' as SessionStatus,
    restartCount: 0,
    ...overrides,
  };
}

describe('parallelConsoleModel', () => {
  it('returns no rows for an empty team', () => {
    expect(toConsoleRows([])).toEqual([]);
  });

  it('projects task, context, usage, cost, tokens, and turns', () => {
    expect(toConsoleRows([
      session({
        status: 'running',
        currentTask: 'Implement the console',
        contextUsage: { tokens: 42_000, window: 100_000, ratio: 0.42, source: 'measured' },
        usage: { inputTokens: 1_500, outputTokens: 500, costUsd: 0.01234, turns: 7, costBasis: 'billed' },
      }, { name: 'Builder', role: 'senior-dev' }),
    ])).toEqual([
      expect.objectContaining({
        id: 'dev',
        name: 'Builder',
        role: 'senior-dev',
        status: 'running',
        statusLabel: 'Running',
        currentTask: 'Implement the console',
        contextPercent: 42,
        contextLabel: 'ctx 42%',
        costLabel: '$0.0123',
        turnsLabel: '7 turns',
        tokenLabel: '2.0k tok',
      }),
    ]);
  });

  // v0.9.108 S2: a subscription's API-equivalent figure says it is a subscription.
  it('marks API-equivalent Claude costs as a subscription with a tilde and tooltip', () => {
    const [row] = toConsoleRows([
      session({
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0431, turns: 1, costBasis: 'api-equivalent' },
      }, { backend: 'claude', provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' } }),
    ]);

    expect(row.costLabel).toBe('Subscription (API-equivalent ~$0.0431)');
    expect(row.costTitle).toContain('API-equivalent cost');
  });

  it('keeps billed costs as plain dollars', () => {
    const [row] = toConsoleRows([
      session({
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0431, turns: 1, costBasis: 'billed' },
      }),
    ]);

    expect(row.costLabel).toBe('$0.0431');
    expect(row.costTitle).toBeUndefined();
  });

  it('uses idle and omits optional metrics without usage or context data', () => {
    const [row] = toConsoleRows([session()]);

    expect(row.currentTask).toBe('idle');
    expect(row.contextLabel).toBeUndefined();
    expect(row.costLabel).toBeUndefined();
    expect(row.turnsLabel).toBeUndefined();
    expect(row.tokenLabel).toBeUndefined();
  });

  it('does not render a fabricated zero-dollar cost before a billing basis is observed', () => {
    const [row] = toConsoleRows([session({
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0 },
    })]);
    expect(row.costLabel).toBe('cost unknown');
    expect(row.costTitle).toContain('does not display $0');
  });

  // v0.9.108 S2: stopped turns, Codex subscriptions and unreported usage each say what they are; none shows $0 or blank.
  it('labels partial, subscription and unreported usage without a zero or a blank', () => {
    const row = (usage: NonNullable<SessionInfo['usage']>, backend?: AgentConfig['backend']) => toConsoleRows([session({ usage }, backend ? { backend } : {})])[0];
    const base = { inputTokens: 10, outputTokens: 5, costUsd: 0, turns: 1 };
    expect(row({ ...base, costUsd: 0.0123, costBasis: 'estimated', partial: true }).costLabel).toBe('Partial usage ~$0.0123');
    expect(row({ ...base, partial: true }).costLabel).toBe('Usage recorded, cost unknown');
    expect(row(base, 'codex').costLabel).toBe('Subscription, no per-turn amount');
    expect(row({ ...base, costUsd: 0.02, costBasis: 'api-equivalent' }, 'codex').costLabel).toBe('Subscription (API-equivalent ~$0.0200)');
    expect(row({ ...base, turns: 0, unknownTurns: 1 }).costLabel).toBe('Usage not reported, cost unknown');
    expect(row({ ...base, costUsd: 0.5, costBasis: 'billed', unknownTurns: 2 }).costLabel).toBe('$0.5000 + 2 turns usage unknown');
    for (const usage of [{ ...base, partial: true }, { ...base, turns: 0, unknownTurns: 1 }, base]) {
      const label = row(usage, 'openai-compat').costLabel!; expect(label).not.toMatch(/\$0(\.0+)?\b/); expect(label.trim()).not.toBe('');
    }
  });

  it('exposes truncated errors for display while keeping the full title', () => {
    const message = `failed ${'x'.repeat(180)}`;
    const [row] = toConsoleRows([
      session({ status: 'error', errorMessage: message }),
    ]);

    expect(row.errorMessage).toHaveLength(140);
    expect(row.errorMessage?.endsWith('…')).toBe(true);
    expect(row.errorTitle).toBe(message);
  });
});
