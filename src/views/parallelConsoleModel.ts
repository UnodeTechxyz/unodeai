import { SessionInfo, SessionStatus } from '../types';
import { sessionCostLabel } from './costLabel';

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
    // v0.9.108 S2: the same spend wording as the chat header; a Codex agent's usage is a subscription.
    const cost = usage ? sessionCostLabel({ ...usage, subscription: session.config.backend === 'codex' }) : undefined;

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
      costLabel: cost?.label,
      costTitle: cost?.title,
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

export { API_EQUIVALENT_COST_TITLE, ESTIMATED_COST_TITLE, MIXED_COST_TITLE, UNKNOWN_COST_TITLE } from './costLabel';

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
