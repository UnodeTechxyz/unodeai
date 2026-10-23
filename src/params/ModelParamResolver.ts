/*---------------------------------------------------------------------------------------------
 *  UnodeAi - ModelParamResolver (v0.1.1 F2)
 *  Resolves an agent's effective model/sampling params from a fallback hierarchy so users can set
 *  org-wide defaults and only override per-agent (or per-task tier) when they need to.
 *
 *  Resolution order (first defined value wins, field by field):
 *    1. agent.modelParams.<field>           — explicit per-agent (team.json members[].modelParams)
 *    2. smartTierParams.<field>             — injected by Smart Mode at dispatch (F3, optional)
 *    3. legacy agent.temperature/maxTokens  — back-compat for old team.json (those two fields only)
 *    4. unode.modelDefaults.<field>          — global VS Code setting
 *    5. HARD_DEFAULTS                        — last-resort built-ins
 *
 *  Pure of vscode: it reads globals through an injected ConfigStore, so it's unit-testable.
 *--------------------------------------------------------------------------------------------*/

import { AgentConfig, AgentModelParams } from '../types';
import { ConfigStore } from '../settings/SettingsBridge';
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from '../contextWindowDefaults';

/** Last-resort defaults when neither the agent nor the global settings specify a value. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

export const HARD_DEFAULTS: AgentModelParams = {
  temperature: 0.7,
  max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
  stream: true,
};

type Effort = NonNullable<AgentModelParams['reasoning_effort']>;
type ResponseFormat = NonNullable<AgentModelParams['response_format']>['type'];

export interface ModelParamDefaultLabels {
  temperature: string;
  topP: string;
  maxTokens: string;
  presencePenalty: string;
  frequencyPenalty: string;
  reasoningEffort: string;
  responseFormat: string;
  stream: string;
  thinking: string;
  toolChoice: string;
  stop: string;
  contextWindow: string;
}

export const PROVIDER_DEFAULT_MODEL_PARAM_LABEL = 'provider default';

export function formatModelParamDefaultLabel(label: string): string {
  return label === PROVIDER_DEFAULT_MODEL_PARAM_LABEL ? 'Provider default' : `${label} (default)`;
}

/** The reasoning-effort values a person can choose, with the label every surface shows for each. */
export const REASONING_EFFORT_CHOICES: ReadonlyArray<readonly [Effort, string]> = [
  ['none', 'None'], ['minimal', 'Minimal'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'],
  ['xhigh', 'X-High'], ['max', 'Max'],
];

/** What a roster shows for an agent's reasoning effort: its configured baseline, never what a turn used. */
export interface ReasoningEffortBaseline {
  /** The visible value. */
  label: string;
  /** Where that value comes from, for the title and the accessible description. */
  basis: string;
}

/**
 * The configured baseline of an agent's reasoning effort, by the rules its turns are resolved with. A route that
 * does not take the field gets none, whatever is saved. A value set on the agent wins. Otherwise the global
 * default applies, and with none of these the field is omitted and the provider decides. A Smart Mode tier value
 * belongs to one task and is no part of the baseline, and nothing here says how much a model actually reasoned.
 */
export function reasoningEffortBaseline(
  agent: Pick<AgentConfig, 'modelParams'>,
  defaults: Pick<ModelParamDefaultLabels, 'reasoningEffort'>,
  routeTakesEffort: boolean,
): ReasoningEffortBaseline {
  if (!routeTakesEffort) {
    return { label: 'Not supported', basis: 'This route does not take a reasoning effort, so none is sent.' };
  }
  const explicit = agent.modelParams?.reasoning_effort;
  if (explicit) {
    const choice = REASONING_EFFORT_CHOICES.find(([value]) => value === explicit);
    return { label: choice ? choice[1] : explicit, basis: 'Set on this agent.' };
  }
  if (defaults.reasoningEffort === PROVIDER_DEFAULT_MODEL_PARAM_LABEL) {
    return { label: formatModelParamDefaultLabel(defaults.reasoningEffort), basis: 'Not set, so none is sent and the provider decides.' };
  }
  // The inherited value reads like a chosen one: the same word, without a "(default)" suffix. That it is
  // inherited is in the basis, which the title and the accessible description carry.
  return {
    label: reasoningEffortChoiceLabel(defaults.reasoningEffort),
    basis: 'Not set on this agent, so the global default applies.',
  };
}

/** The label every surface shows for a reasoning-effort value; a value outside the choices is shown as it is. */
function reasoningEffortChoiceLabel(value: string): string {
  return REASONING_EFFORT_CHOICES.find(([choice]) => choice === value)?.[1] ?? value;
}

/** Fallback for tests/non-extension renderers that do not inject the real VS Code config store. */
export const DEFAULT_MODEL_PARAM_DEFAULT_LABELS: ModelParamDefaultLabels = {
  temperature: '0.7',
  topP: '1',
  maxTokens: String(DEFAULT_MAX_OUTPUT_TOKENS),
  presencePenalty: PROVIDER_DEFAULT_MODEL_PARAM_LABEL,
  frequencyPenalty: PROVIDER_DEFAULT_MODEL_PARAM_LABEL,
  reasoningEffort: 'medium',
  responseFormat: PROVIDER_DEFAULT_MODEL_PARAM_LABEL,
  stream: 'on',
  thinking: PROVIDER_DEFAULT_MODEL_PARAM_LABEL,
  toolChoice: PROVIDER_DEFAULT_MODEL_PARAM_LABEL,
  stop: PROVIDER_DEFAULT_MODEL_PARAM_LABEL,
  contextWindow: String(DEFAULT_CONTEXT_WINDOW_TOKENS),
};

/** Read the global `unode.modelDefaults.*` settings into an AgentModelParams shape. */
export function readGlobalModelDefaults(config: ConfigStore): AgentModelParams {
  const g: AgentModelParams = {};
  const temperature = config.get<number | null>('modelDefaults.temperature', null);
  const topP = config.get<number | null>('modelDefaults.topP', null);
  const maxTokens = config.get<number | null>('modelDefaults.maxTokens', null);
  const effort = config.get<string>('modelDefaults.reasoningEffort', '');
  const stream = config.get<boolean | null>('modelDefaults.stream', null);
  const responseFormat = config.get<string>('modelDefaults.responseFormat', '');

  if (typeof temperature === 'number') g.temperature = temperature;
  if (typeof topP === 'number') g.top_p = topP;
  if (typeof maxTokens === 'number') g.max_tokens = maxTokens;
  if (effort) g.reasoning_effort = effort as Effort;
  if (typeof stream === 'boolean') g.stream = stream;
  if (responseFormat) g.response_format = { type: responseFormat as ResponseFormat };
  return g;
}

/** Resolve the global+hard fallback layer only, with the same omission semantics as `resolve()`. */
export function resolveModelParamDefaults(config: ConfigStore): AgentModelParams {
  const globals = readGlobalModelDefaults(config);
  const resolved: AgentModelParams = {
    temperature: globals.temperature ?? HARD_DEFAULTS.temperature,
    top_p: globals.top_p ?? HARD_DEFAULTS.top_p,
    presence_penalty: globals.presence_penalty ?? HARD_DEFAULTS.presence_penalty,
    frequency_penalty: globals.frequency_penalty ?? HARD_DEFAULTS.frequency_penalty,
    thinking: globals.thinking ?? HARD_DEFAULTS.thinking,
    reasoning_effort: globals.reasoning_effort ?? HARD_DEFAULTS.reasoning_effort,
    max_tokens: globals.max_tokens ?? HARD_DEFAULTS.max_tokens,
    stop: globals.stop ?? HARD_DEFAULTS.stop,
    response_format: globals.response_format ?? HARD_DEFAULTS.response_format,
    tool_choice: globals.tool_choice ?? HARD_DEFAULTS.tool_choice,
    stream: globals.stream ?? HARD_DEFAULTS.stream,
  };
  for (const k of Object.keys(resolved) as (keyof AgentModelParams)[]) {
    if (resolved[k] === undefined) {
      delete resolved[k];
    }
  }
  return resolved;
}

export function modelParamDefaultLabels(config: ConfigStore): ModelParamDefaultLabels {
  const defaults = resolveModelParamDefaults(config);
  return {
    temperature: valueLabel(defaults.temperature),
    topP: valueLabel(defaults.top_p),
    maxTokens: valueLabel(defaults.max_tokens),
    presencePenalty: valueLabel(defaults.presence_penalty),
    frequencyPenalty: valueLabel(defaults.frequency_penalty),
    reasoningEffort: defaults.reasoning_effort ?? PROVIDER_DEFAULT_MODEL_PARAM_LABEL,
    responseFormat: defaults.response_format?.type ?? PROVIDER_DEFAULT_MODEL_PARAM_LABEL,
    stream: defaults.stream === true ? 'on' : defaults.stream === false ? 'off' : PROVIDER_DEFAULT_MODEL_PARAM_LABEL,
    thinking: defaults.thinking?.type === 'enabled' ? 'enabled' : defaults.thinking?.type === 'disabled' ? 'off' : PROVIDER_DEFAULT_MODEL_PARAM_LABEL,
    toolChoice: defaults.tool_choice ?? PROVIDER_DEFAULT_MODEL_PARAM_LABEL,
    stop: stopLabel(defaults.stop),
    contextWindow: String(DEFAULT_CONTEXT_WINDOW_TOKENS),
  };
}

function valueLabel(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : PROVIDER_DEFAULT_MODEL_PARAM_LABEL;
}

function stopLabel(value: AgentModelParams['stop']): string {
  if (Array.isArray(value)) {
    return value.length ? value.join('\\n') : PROVIDER_DEFAULT_MODEL_PARAM_LABEL;
  }
  return value ? String(value) : PROVIDER_DEFAULT_MODEL_PARAM_LABEL;
}

export class ModelParamResolver {
  constructor(private config: ConfigStore) {}

  /**
   * Resolve the effective params for an agent's turn. `smartTierParams` (F3) wins over the agent's
   * legacy fields and globals, but never over the agent's explicit `modelParams`.
   */
  resolve(agent: AgentConfig, smartTierParams?: AgentModelParams): AgentModelParams {
    const explicit = agent.modelParams ?? {};
    const tier = smartTierParams ?? {};
    const globals = readGlobalModelDefaults(this.config);

    const pick = <K extends keyof AgentModelParams>(
      key: K,
      legacy?: AgentModelParams[K]
    ): AgentModelParams[K] | undefined =>
      explicit[key] ?? tier[key] ?? legacy ?? globals[key] ?? HARD_DEFAULTS[key];

    const resolved: AgentModelParams = {
      temperature: pick('temperature', agent.temperature),
      top_p: pick('top_p'),
      presence_penalty: pick('presence_penalty'),
      frequency_penalty: pick('frequency_penalty'),
      thinking: pick('thinking'),
      reasoning_effort: pick('reasoning_effort'),
      max_tokens: pick('max_tokens', agent.maxTokens),
      stop: pick('stop'),
      response_format: pick('response_format'),
      tool_choice: pick('tool_choice'),
      stream: pick('stream'),
    };

    // Drop undefined fields so callers can spread only what was actually resolved.
    for (const k of Object.keys(resolved) as (keyof AgentModelParams)[]) {
      if (resolved[k] === undefined) {
        delete resolved[k];
      }
    }
    return resolved;
  }

}
