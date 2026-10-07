/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Smart compaction preview text (v0.9.90 Smart compaction design, §4.1)
 *
 *  Turns one resolution into the words Agent Settings shows. The preview always states the actual rule —
 *  every term of the minimum and which one wins — so a user can see why compaction will run when it does.
 *--------------------------------------------------------------------------------------------*/

import type { CompactionWorkProfile, ContextWindowSource } from '../types';
import {
  compactionSizing,
  formatTokens,
  isCompactionWorkProfile,
  profileLabel,
  type AgentCompactionFields,
  type ProfileResolutionSource,
  type SmartCompactionResolution,
} from './SmartCompactionPolicy';

export const SMART_COMPACTION_HELP = 'This schedules compaction; it does not block tasks.';

export interface SmartCompactionPreviewContext {
  contextWindow?: { tokens: number; source: ContextWindowSource };
  /** Whose summary replaces the history: UnodeAi's (OpenAI-compatible) or the runtime's own (Claude, Codex). */
  mechanism: { kind: 'host-history' } | { kind: 'native-runtime'; runtimeName: string };
  /** What Auto resolves to for this agent, and from what. */
  auto?: { profile: CompactionWorkProfile; source: ProfileResolutionSource; sourceName?: string };
  /** Claude only: its own in-turn threshold as installed at process start, and whether its bounds moved it. */
  nativeThreshold?: { tokens: number; clamped?: 'minimum' | 'maximum' };
  /** Codex: the runtime keeps compacting inside long turns at a threshold UnodeAi neither sets nor turns off. */
  runtimeOwnThreshold?: boolean;
}

export interface SmartCompactionPreview {
  /** One line for the collapsed section header. */
  summary: string;
  /** The calculated rule, with every term. */
  rule: string;
  /** What a compaction keeps and aims for, when the route lets UnodeAi decide. */
  sizing?: string;
  warning?: string;
  /** The label of the Auto work-profile choice. */
  autoLabel: string;
  unavailable: boolean;
}

const WINDOW_LABELS: Record<ContextWindowSource, string> = {
  measured: 'Advertised window',
  configured: 'Your context window',
  observed: 'Observed window limit',
  assumed: 'Assumed window',
};

export function describeSmartCompaction(
  resolution: SmartCompactionResolution,
  context: SmartCompactionPreviewContext,
): SmartCompactionPreview {
  const autoLabel = autoProfileLabel(context.auto);
  if (resolution.status === 'unavailable') {
    return {
      summary: 'Unavailable',
      rule: `Automatic compaction is unavailable: ${resolution.reason}. Tasks are still sent, and the existing `
        + 'context-limit guard still applies.',
      autoLabel,
      unavailable: true,
    };
  }
  const policy = resolution.policy;
  const runtimeOwn = context.runtimeOwnThreshold && context.mechanism.kind === 'native-runtime'
    ? context.mechanism.runtimeName
    : undefined;
  if (policy.mode === 'off' || policy.activeTriggerTokens === undefined) {
    return {
      summary: 'Off · manual only',
      rule: 'Automatic compaction is off for this agent. Compact by hand whenever you choose; the existing '
        + 'context-limit guard still applies.'
        + (runtimeOwn ? ` ${runtimeOwn} still compacts on its own threshold inside a long turn; UnodeAi does not change that.` : ''),
      autoLabel,
      unavailable: false,
    };
  }

  const terms: string[] = [];
  if (resolution.windowShareTokens !== undefined && context.contextWindow) {
    terms.push(`${WINDOW_LABELS[context.contextWindow.source]} ${formatTokens(context.contextWindow.tokens)} · `
      + `${policy.windowPercent}% = ${formatTokens(resolution.windowShareTokens)}`);
  }
  terms.push(`${policy.mode === 'custom' ? 'your ceiling' : 'profile ceiling'} ${formatTokens(policy.ceilingTokens)}`);
  if (policy.routeEvidenceCapTokens !== undefined) {
    terms.push(`route evidence cap ${formatTokens(policy.routeEvidenceCapTokens)}`);
  }
  terms.push(`auto-compact at ${formatTokens(policy.activeTriggerTokens)}`);
  const rule = capitalize(`${terms.join(' · ')}.`);

  const summary = policy.mode === 'custom'
    ? `Custom · auto-compact at ${formatTokens(policy.activeTriggerTokens)}`
    : `Smart · ${policy.profile ? profileLabel(policy.profile) : 'Balanced'} · auto-compact at `
      + formatTokens(policy.activeTriggerTokens);

  const sizing = compactionSizing(policy);
  const sizingText = !sizing
    ? undefined
    : context.mechanism.kind === 'host-history'
      ? `After compacting, it keeps up to ${formatTokens(sizing.recentTailTokens)} recent tokens word for word and `
        + `aims for about ${formatTokens(sizing.postCompactTargetTokens)} in total.`
      : `${context.mechanism.runtimeName} writes its own summary, so the recent-tail and target sizes apply to `
        + 'OpenAI-compatible routes only.'
        + (context.nativeThreshold
          ? ` Inside a long turn it also compacts on its own at about ${formatTokens(context.nativeThreshold.tokens)} tokens`
            + (context.nativeThreshold.clamped === 'minimum'
              ? ` (${context.mechanism.runtimeName}'s lowest setting, above this trigger)`
              : context.nativeThreshold.clamped === 'maximum' ? ` (${context.mechanism.runtimeName}'s highest setting)` : '')
            + '; a change applies when the agent restarts.'
          : runtimeOwn ? ` Inside a long turn it may also compact at its own threshold, which UnodeAi does not set.` : '');

  const warning = resolution.customIgnoresEvidenceCapTokens === undefined
    ? undefined
    : `Field evidence caps this model at ${formatTokens(resolution.customIgnoresEvidenceCapTokens)} tokens in Smart `
      + 'mode. Custom uses your numbers instead.';

  return {
    summary,
    rule,
    ...(sizingText ? { sizing: sizingText } : {}),
    ...(warning ? { warning } : {}),
    autoLabel,
    unavailable: false,
  };
}

/** The saved choice in a few words, for places that show it without resolving (the roster gear menu). */
export function smartCompactionChoiceLabel(config: AgentCompactionFields): string {
  switch (config.smartCompactionMode) {
    case 'off':
      return 'Off — compact only by hand';
    case 'custom':
      return config.smartCompactionWindowPercent !== undefined && config.smartCompactionCeilingTokens !== undefined
        ? `Custom — ${config.smartCompactionWindowPercent}% or ${formatTokens(config.smartCompactionCeilingTokens)} tokens`
        : 'Custom — needs its numbers';
    default:
      return isCompactionWorkProfile(config.smartCompactionProfile)
        ? `Smart — ${profileLabel(config.smartCompactionProfile)}`
        : 'Smart — Auto work profile';
  }
}

export function autoProfileLabel(auto: SmartCompactionPreviewContext['auto']): string {
  if (!auto) return 'Auto';
  const from = auto.source === 'role-template'
    ? `${auto.sourceName ?? 'role'} template`
    : auto.source === 'skill-category'
      ? `${auto.sourceName ?? 'primary'} skill`
      : auto.source === 'agent'
        ? 'this agent'
        : 'default';
  return `Auto: ${profileLabel(auto.profile)} — ${from}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
