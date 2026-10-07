/**
 * Data carried by a Harness Lab A/B arm.
 *
 * This is deliberately a small projection of existing product controls.  It does not create a
 * second configuration system: Tier 2 forwards these values to the existing AgentConfig and Tier 1
 * forwards the command allowlist to the real CommandPolicy probe. The bounded `implementation` axis
 * selects the two installed edit-tool surfaces for the named P1 mechanism probe only; it is never
 * persisted as an AgentConfig setting or used to spend Tier 2 model routes.
 */

import type { ToolProtocolKind } from '../types';

export const TIER2_TASK_IDS = ['A1', 'A2', 'A3', 'A4'] as const;
export type Tier2TaskId = typeof TIER2_TASK_IDS[number];

/** Explicit, non-persisted edit surfaces available to a named implementation comparison. */
export type HarnessImplementation = 'apply-edit' | 'apply-patch';
/** P2's explicit project-context arm. This is Harness-only and never persisted in AgentConfig. */
export type ProjectKnowledgeDisclosure = 'full' | 'progressive';

export interface HarnessLabConfiguration {
  /** Stable, human-readable arm identity included in every comparison record. */
  readonly name: string;
  /**
   * Harness-only implementation identity. This never reaches persisted AgentConfig. The active P1
   * comparison requires the two distinct installed edit-tool surfaces.
   */
  readonly implementation?: HarnessImplementation;
  /** P2: compare former whole-context assembly with the shipped L1 + on-demand assembly. */
  readonly projectKnowledgeDisclosure?: ProjectKnowledgeDisclosure;
  /** Existing OpenAI-compatible native/XML tool-protocol control. Claude Headless ignores it. */
  readonly toolProtocol?: ToolProtocolKind;
  /** Existing agent tool allowlist supplied to the real Tier 2 AgentConfig. */
  readonly allowedTools?: readonly string[];
  /** Existing per-turn Lab timeout; it bounds a real Tier 2 backend turn. */
  readonly turnTimeoutMs?: number;
  /** Optional, explicit Lab-only system-prompt appendix. It is never enabled implicitly. */
  readonly promptInjection?: {
    readonly enabled: boolean;
    readonly text?: string;
  };
  /** Existing command-policy allowlist exercised by Tier 1 C1/C2. */
  readonly commandAllowlist?: readonly string[];
  /**
   * A checked-in fixture directory, selected as data. This is for instrument-repair demonstrations;
   * a fixture-different comparison is labelled as such and cannot be used as a capability claim.
   */
  readonly fixtureOverrides?: Partial<Record<Tier2TaskId, string>>;
}

export type HarnessLabConfigurationAxis =
  | 'implementation'
  | 'projectKnowledgeDisclosure'
  | 'toolProtocol'
  | 'allowedTools'
  | 'turnTimeoutMs'
  | 'promptInjection'
  | 'commandAllowlist'
  | 'fixtureOverrides';

export function assertHarnessLabConfiguration(value: HarnessLabConfiguration): void {
  if (!value || typeof value !== 'object' || !isNonEmptyString(value.name)) {
    throw new Error('Harness Lab configuration requires a non-empty name.');
  }
  if (value.implementation !== undefined && value.implementation !== 'apply-edit' && value.implementation !== 'apply-patch') {
    throw new Error('Harness Lab implementation must be apply-edit or apply-patch during an active comparison.');
  }
  if (value.projectKnowledgeDisclosure !== undefined && value.projectKnowledgeDisclosure !== 'full' && value.projectKnowledgeDisclosure !== 'progressive') {
    throw new Error('Harness Lab projectKnowledgeDisclosure must be full or progressive.');
  }
  if (value.toolProtocol !== undefined && value.toolProtocol !== 'native' && value.toolProtocol !== 'xml') {
    throw new Error('Harness Lab toolProtocol must be native or xml.');
  }
  assertStringList(value.allowedTools, 'allowedTools');
  assertStringList(value.commandAllowlist, 'commandAllowlist');
  if (value.turnTimeoutMs !== undefined && (!Number.isInteger(value.turnTimeoutMs) || value.turnTimeoutMs <= 0)) {
    throw new Error('Harness Lab turnTimeoutMs must be a positive integer.');
  }
  if (value.promptInjection !== undefined) {
    if (typeof value.promptInjection.enabled !== 'boolean') {
      throw new Error('Harness Lab promptInjection.enabled must be a boolean.');
    }
    if (value.promptInjection.enabled && (!isNonEmptyString(value.promptInjection.text) || value.promptInjection.text.length > 4_000)) {
      throw new Error('An enabled Harness Lab promptInjection requires text no longer than 4000 characters.');
    }
    if (!value.promptInjection.enabled && value.promptInjection.text !== undefined) {
      throw new Error('A disabled Harness Lab promptInjection must not carry text.');
    }
  }
  if (value.fixtureOverrides !== undefined) {
    for (const [taskId, fixture] of Object.entries(value.fixtureOverrides)) {
      if (!(TIER2_TASK_IDS as readonly string[]).includes(taskId) || !isCheckedInFixturePath(fixture)) {
        throw new Error('Harness Lab fixtureOverrides must name a Tier 2 task and a checked-in fixture directory.');
      }
    }
  }
}

export function harnessLabConfigurationAxes(configuration: HarnessLabConfiguration): HarnessLabConfigurationAxis[] {
  assertHarnessLabConfiguration(configuration);
  const axes: HarnessLabConfigurationAxis[] = [];
  if (configuration.implementation !== undefined) axes.push('implementation');
  if (configuration.projectKnowledgeDisclosure !== undefined) axes.push('projectKnowledgeDisclosure');
  if (configuration.toolProtocol !== undefined) axes.push('toolProtocol');
  if (configuration.allowedTools !== undefined) axes.push('allowedTools');
  if (configuration.turnTimeoutMs !== undefined) axes.push('turnTimeoutMs');
  if (configuration.promptInjection?.enabled) axes.push('promptInjection');
  if (configuration.commandAllowlist !== undefined) axes.push('commandAllowlist');
  if (configuration.fixtureOverrides !== undefined && Object.keys(configuration.fixtureOverrides).length > 0) axes.push('fixtureOverrides');
  return axes;
}

function assertStringList(value: readonly string[] | undefined, name: string): void {
  if (value !== undefined && (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry)) || new Set(value).size !== value.length)) {
    throw new Error(`Harness Lab ${name} must be a list of unique non-empty strings.`);
  }
}

function isCheckedInFixturePath(value: unknown): value is string {
  return typeof value === 'string'
    && /^src\/harness\/fixtures\/[A-Za-z0-9._/-]+$/.test(value)
    && !value.split('/').includes('..');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
