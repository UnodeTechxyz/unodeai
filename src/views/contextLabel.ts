export interface ChatContextUsage {
  tokens: number;
  window: number;
  ratio: number;
}

export interface ContextLabel {
  text: string;
  percent: number;
  level: 'none' | 'low' | 'medium' | 'high';
}

export function contextLabel(
  context: ChatContextUsage | undefined,
  backend: string | undefined
): ContextLabel {
  if (backend === 'claude') {
    return { text: 'Context managed by Claude', percent: 0, level: 'none' };
  }
  if (!context || context.window <= 0) {
    return { text: 'Context not measured yet', percent: 0, level: 'none' };
  }
  const ratio = clamp(context.ratio);
  const percent = Math.round(ratio * 100);
  return {
    text: `${percent}% of ${formatTokenWindow(context.window)}`,
    percent,
    level: ratio >= 0.75 ? 'high' : ratio >= 0.5 ? 'medium' : 'low',
  };
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.min(1, Math.max(0, n));
}

function formatTokenWindow(tokens: number): string {
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}k tokens`;
  }
  return `${Math.max(0, Math.floor(tokens))} tokens`;
}
