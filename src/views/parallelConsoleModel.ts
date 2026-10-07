import { SessionInfo, SessionStatus } from '../types';

export interface ConsoleRow {
  id: string;
  name: string;
  role: string;
  status: SessionStatus;
  statusEmoji: string;
  statusLabel: string;
  currentTask: string;
  currentTaskTitle: string;
  contextPercent?: number;
  contextLabel?: string;
  costLabel?: string;
  costTitle?: string;
  turnsLabel?: string;
  tokenLabel?: string;
  errorMessage?: string;
  errorTitle?: string;
}

const TASK_LIMIT = 96;
const ERROR_LIMIT = 140;

export function toConsoleRows(sessions: SessionInfo[]): ConsoleRow[] {
  return sessions.map((session) => {
    const usage = session.usage;
    const contextPercent = session.contextUsage
      ? Math.round(session.contextUsage.ratio * 100)
      : undefined;
    const task = normalizeText(session.currentTask) || 'idle';
    const error = normalizeText(session.errorMessage);

    return {
      id: session.id,
      name: session.config.name,
      role: session.config.role,
      status: session.status,
      statusEmoji: stateEmoji(session.status),
      statusLabel: statusLabel(session.status),
      currentTask: truncate(task, TASK_LIMIT),
      currentTaskTitle: task,
      contextPercent,
      contextLabel: contextPercent === undefined ? undefined : `ctx ${contextPercent}%`,
      costLabel: usage ? formatCost(usage.costUsd, usage.costBasis, usage.turns) : undefined,
      costTitle: usage ? costTitle(usage.costBasis, usage.turns) : undefined,
      turnsLabel: usage ? `${usage.turns} ${usage.turns === 1 ? 'turn' : 'turns'}` : undefined,
      tokenLabel: usage ? formatTokens(usage.inputTokens + usage.outputTokens) : undefined,
      errorMessage: error ? truncate(error, ERROR_LIMIT) : undefined,
      errorTitle: error || undefined,
    };
  });
}

export function stateEmoji(status: SessionStatus): string {
  switch (status) {
    case 'running': return '🏃';
    case 'idle': return '🧘';
    case 'stopped': return '😴';
    case 'error': return '🤒';
    case 'starting': return '🚦';
    case 'stopping': return '🚦';
    // Blocked on a human consent answer — must not read as the idle/zen default.
    case 'consent_required': return '🔐';
    default: return '🧘';
  }
}

function statusLabel(status: SessionStatus): string {
  // Statuses are single words except consent_required; render it as prose, not a raw identifier.
  const spaced = status.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export const API_EQUIVALENT_COST_TITLE =
  "API-equivalent cost. This is a pricing estimate for subscription-authenticated CLI usage, not a billed per-token invoice.";

export const UNKNOWN_COST_TITLE =
  'Cost basis has not been observed for a completed turn, so UnodeAi does not display $0 as if it were a bill.';

export const ESTIMATED_COST_TITLE =
  'Estimated cost from a labelled price source (an account, user-configured or reference price), not a provider bill. See Dashboard → Spend for the source and date.';

export const MIXED_COST_TITLE =
  'This agent has turns with different cost bases (or an unpriced turn); the total is approximate. See Dashboard → Spend for separate rows.';

type LegacyCostBasis = 'billed' | 'api-equivalent' | 'estimated' | 'mixed' | undefined;

function formatCost(costUsd: number, basis: LegacyCostBasis, turns: number): string {
  if (turns <= 0 || !basis) {
    return 'cost unknown';
  }
  return `${basis === 'billed' ? '' : '~'}$${costUsd.toFixed(4)}`;
}

function costTitle(basis: LegacyCostBasis, turns: number): string | undefined {
  if (turns <= 0 || !basis) {
    return UNKNOWN_COST_TITLE;
  }
  return basis === 'api-equivalent' ? API_EQUIVALENT_COST_TITLE
    : basis === 'estimated' ? ESTIMATED_COST_TITLE
    : basis === 'mixed' ? MIXED_COST_TITLE
    : undefined;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M tok`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k tok`;
  }
  return `${tokens} tok`;
}

function normalizeText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
