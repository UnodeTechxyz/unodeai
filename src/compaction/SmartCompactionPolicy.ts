/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Smart compaction policy (v0.9.90 Smart compaction design, §4.1)
 *
 *  Validates the versioned policy data and resolves one agent's automatic-compaction trigger from it.
 *  This module owns the rules, never the numbers: every default, profile row, role mapping and route
 *  evidence cap comes from the policy data the caller passes in. Data that does not validate makes the
 *  affected mode unavailable with a stated reason; nothing here falls back to a numeric literal.
 *
 *  A trigger schedules compaction. It is never a context limit and never refuses a task.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import type {
  AgentConfig,
  CompactionWorkProfile,
  ContextWindowSource,
  SkillCategory,
  SmartCompactionMode,
} from '../types';

export const SMART_COMPACTION_MODES: readonly SmartCompactionMode[] = ['smart', 'custom', 'off'];

export const COMPACTION_WORK_PROFILES = [
  'balanced',
  'iterative-delivery',
  'research-synthesis',
  'qa-debugging',
  'deep-build',
] as const satisfies readonly CompactionWorkProfile[];

export const SKILL_CATEGORIES = [
  'development', 'testing', 'design', 'documentation', 'management', 'security', 'infrastructure', 'data', 'external',
] as const satisfies readonly SkillCategory[];

// Both lists must name every member of their union, so a new profile or category cannot be added to the type
// without the validator learning it.
const profilesAreExhaustive: [Exclude<CompactionWorkProfile, (typeof COMPACTION_WORK_PROFILES)[number]>] extends [never] ? true : never = true;
const skillCategoriesAreExhaustive: [Exclude<SkillCategory, (typeof SKILL_CATEGORIES)[number]>] extends [never] ? true : never = true;
void profilesAreExhaustive;
void skillCategoriesAreExhaustive;

/** What a user or a file may choose. These bound a setting; they are not defaults. */
export const WINDOW_PERCENT_RANGE = { min: 10, max: 90 } as const;
export const TOKEN_VALUE_RANGE = { min: 16_384, max: 2_000_000 } as const;

export interface SmartCompactionProfileValues {
  windowPercent: number;
  ceilingTokens: number;
  recentTailTokens: number;
  postCompactTargetTokens: number;
}

export const PROFILE_VALUE_FIELDS = [
  'windowPercent',
  'ceilingTokens',
  'recentTailTokens',
  'postCompactTargetTokens',
] as const satisfies readonly (keyof SmartCompactionProfileValues)[];
type ProfileValueField = (typeof PROFILE_VALUE_FIELDS)[number];

/** The three token cells a cross-field conflict drops together, keeping any valid window share. */
const TOKEN_BUNDLE: readonly ProfileValueField[] = ['ceilingTokens', 'recentTailTokens', 'postCompactTargetTokens'];

/** A product-maintained cap for one exact route/model pair, admitted only from accepted field evidence. */
export interface RouteEvidenceCap {
  connectionId: string;
  /** Trimmed and lower-cased; matched exactly, never by alias. */
  modelId: string;
  capTokens: number;
  evidence: string;
}

export interface SmartCompactionPolicyData {
  revision: string;
  profiles: Readonly<Record<CompactionWorkProfile, SmartCompactionProfileValues>>;
  profileByRoleTemplate: Readonly<Record<string, CompactionWorkProfile>>;
  profileBySkillCategory: Readonly<Partial<Record<SkillCategory, CompactionWorkProfile>>>;
  routeEvidenceCaps: readonly RouteEvidenceCap[];
}

export type PolicySection<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The bundled file, validated. Custom is judged apart from the Smart sections, so a broken profile table or
 * mapping makes only Smart unavailable while a valid `customDefaults` keeps Custom working.
 */
export interface LoadedSmartCompactionPolicy {
  /** The file's own revision; absent when the file is unusable as a whole. */
  revision?: string;
  custom: PolicySection<SmartCompactionProfileValues>;
  smart: PolicySection<SmartCompactionPolicyData>;
}

/** Team-level edits to the profile table: only the cells that differ, per profile row. */
export type SmartCompactionProfileOverrides = Partial<Record<CompactionWorkProfile, Partial<SmartCompactionProfileValues>>>;

export type AgentCompactionFields = Pick<
  AgentConfig,
  'smartCompactionMode' | 'smartCompactionProfile' | 'smartCompactionWindowPercent' | 'smartCompactionCeilingTokens'
>;

export const AGENT_COMPACTION_FIELDS = [
  'smartCompactionMode',
  'smartCompactionProfile',
  'smartCompactionWindowPercent',
  'smartCompactionCeilingTokens',
] as const satisfies readonly (keyof AgentCompactionFields)[];

export type TriggerTerm = 'window-share' | 'practical-ceiling' | 'route-evidence-cap';
export type ProfileResolutionSource = 'agent' | 'role-template' | 'skill-category' | 'fallback';

/** The one object Settings, SessionManager and receipts consume (design §4.1). */
export interface ResolvedSmartCompactionPolicy {
  mode: SmartCompactionMode;
  profile?: CompactionWorkProfile;
  resolutionSource?: ProfileResolutionSource;
  /** First 12 hex characters of SHA-256 over the canonical effective policy: a change and cooldown identity. */
  revision: string;
  windowPercent: number;
  ceilingTokens: number;
  recentTailTokens: number;
  postCompactTargetTokens: number;
  routeEvidenceCapTokens?: number;
  /** Absent only when Off. An unavailable window-share term is left out of the minimum. */
  activeTriggerTokens?: number;
  winningTerm?: TriggerTerm;
}

export interface SmartCompactionResolutionInput {
  policy: LoadedSmartCompactionPolicy;
  agent: Pick<AgentConfig, 'roleTemplateKey' | 'skills'> & AgentCompactionFields;
  teamOverrides?: SmartCompactionProfileOverrides;
  /** The window of the model that will serve the turn; absent leaves the window-share term out. */
  contextWindow?: { tokens: number; source: ContextWindowSource };
  /** The connection and model that will serve the turn (a fallback or Smart Mode model, not the roster default). */
  route?: { connectionId: string; modelId: string };
}

export type SmartCompactionResolution =
  | {
      status: 'resolved';
      policy: ResolvedSmartCompactionPolicy;
      /** The window-share term, when a window was known. */
      windowShareTokens?: number;
      /** Custom only: a cap that applies to this route/model in Smart mode and that Custom deliberately ignores. */
      customIgnoresEvidenceCapTokens?: number;
    }
  | { status: 'unavailable'; mode: SmartCompactionMode; reason: string };

const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion', 'revision', 'customDefaults', 'profiles', 'profileByRoleTemplate', 'profileBySkillCategory',
  'routeEvidenceCaps',
]);
const ROUTE_CAP_FIELDS = new Set(['connectionId', 'modelId', 'capTokens', 'evidence']);

export function isCompactionWorkProfile(value: unknown): value is CompactionWorkProfile {
  return typeof value === 'string' && (COMPACTION_WORK_PROFILES as readonly string[]).includes(value);
}

export function isSmartCompactionMode(value: unknown): value is SmartCompactionMode {
  return typeof value === 'string' && (SMART_COMPACTION_MODES as readonly string[]).includes(value);
}

function isSkillCategory(value: unknown): value is SkillCategory {
  return typeof value === 'string' && (SKILL_CATEGORIES as readonly string[]).includes(value);
}

/** Why one cell is unacceptable, or undefined when it is fine. */
export function profileValueProblem(field: ProfileValueField, value: unknown): string | undefined {
  const range = field === 'windowPercent' ? WINDOW_PERCENT_RANGE : TOKEN_VALUE_RANGE;
  if (typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max) {
    return undefined;
  }
  return field === 'windowPercent'
    ? `must be a whole percent from ${range.min} to ${range.max}`
    : `must be a whole number of tokens from ${formatTokens(range.min)} to ${formatTokens(range.max)}`;
}

/** Why a complete row is inconsistent, or undefined when its cells agree. */
export function profileRowProblem(row: SmartCompactionProfileValues): string | undefined {
  if (row.recentTailTokens > row.postCompactTargetTokens) {
    return 'the recent tail must not exceed the post-compact target';
  }
  if (row.postCompactTargetTokens >= row.ceilingTokens) {
    return 'the post-compact target must be below the practical ceiling';
  }
  return undefined;
}

export function loadSmartCompactionPolicy(raw: unknown): LoadedSmartCompactionPolicy {
  const unusable = (error: string): LoadedSmartCompactionPolicy => ({
    custom: { ok: false, error },
    smart: { ok: false, error },
  });
  if (!isRecord(raw)) return unusable('the policy file is not a JSON object');
  if (raw.schemaVersion !== 1) return unusable('the policy file has an unsupported schemaVersion');
  if (typeof raw.revision !== 'string' || raw.revision.trim() === '') {
    return unusable('the policy file has no revision');
  }
  const revision = raw.revision;
  const customRow = validateValuesRow(raw.customDefaults, 'customDefaults');
  const custom: PolicySection<SmartCompactionProfileValues> = typeof customRow === 'string'
    ? { ok: false, error: customRow }
    : { ok: true, value: customRow };
  return { revision, custom, smart: validateSmartSections(raw, revision) };
}

function validateSmartSections(raw: Record<string, unknown>, revision: string): PolicySection<SmartCompactionPolicyData> {
  const fail = (error: string): PolicySection<SmartCompactionPolicyData> => ({ ok: false, error });
  const unknown = Object.keys(raw).filter((key) => !TOP_LEVEL_FIELDS.has(key));
  if (unknown.length > 0) return fail(`the policy file has unknown field(s): ${unknown.join(', ')}`);

  if (!isRecord(raw.profiles)) return fail('profiles must be an object');
  const profileKeys = Object.keys(raw.profiles);
  const unknownProfiles = profileKeys.filter((key) => !isCompactionWorkProfile(key));
  if (unknownProfiles.length > 0) return fail(`profiles has unknown profile(s): ${unknownProfiles.join(', ')}`);
  const profiles = {} as Record<CompactionWorkProfile, SmartCompactionProfileValues>;
  for (const id of COMPACTION_WORK_PROFILES) {
    const row = validateValuesRow(raw.profiles[id], `profiles.${id}`);
    if (typeof row === 'string') return fail(row);
    profiles[id] = row;
  }

  if (!isRecord(raw.profileByRoleTemplate)) return fail('profileByRoleTemplate must be an object');
  const profileByRoleTemplate: Record<string, CompactionWorkProfile> = {};
  for (const [key, value] of Object.entries(raw.profileByRoleTemplate)) {
    if (key.trim() === '' || !isCompactionWorkProfile(value)) {
      return fail(`profileByRoleTemplate.${key} must name a known profile`);
    }
    profileByRoleTemplate[key] = value;
  }

  if (!isRecord(raw.profileBySkillCategory)) return fail('profileBySkillCategory must be an object');
  const profileBySkillCategory: Partial<Record<SkillCategory, CompactionWorkProfile>> = {};
  for (const [key, value] of Object.entries(raw.profileBySkillCategory)) {
    if (!isSkillCategory(key)) return fail(`profileBySkillCategory has unknown skill category ${key}`);
    if (!isCompactionWorkProfile(value)) return fail(`profileBySkillCategory.${key} must name a known profile`);
    profileBySkillCategory[key] = value;
  }

  if (!Array.isArray(raw.routeEvidenceCaps)) return fail('routeEvidenceCaps must be an array');
  const routeEvidenceCaps: RouteEvidenceCap[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.routeEvidenceCaps.entries()) {
    const path = `routeEvidenceCaps[${index}]`;
    if (!isRecord(entry)) return fail(`${path} must be an object`);
    const extra = Object.keys(entry).filter((key) => !ROUTE_CAP_FIELDS.has(key));
    if (extra.length > 0) return fail(`${path} has unknown field(s): ${extra.join(', ')}`);
    const { connectionId, modelId, capTokens, evidence } = entry;
    if (typeof connectionId !== 'string' || connectionId.trim() === '' || connectionId !== connectionId.trim()) {
      return fail(`${path}.connectionId must be a non-empty trimmed string`);
    }
    if (typeof modelId !== 'string' || modelId === '' || modelId !== normalizeModelId(modelId)) {
      return fail(`${path}.modelId must be a non-empty, trimmed, lower-case model id`);
    }
    const capProblem = profileValueProblem('ceilingTokens', capTokens);
    if (capProblem) return fail(`${path}.capTokens ${capProblem}`);
    if (typeof evidence !== 'string' || evidence.trim() === '') return fail(`${path}.evidence must name the accepted evidence`);
    const key = `${connectionId}\u0000${modelId}`;
    if (seen.has(key)) return fail(`${path} repeats the cap for ${connectionId} ${modelId}`);
    seen.add(key);
    routeEvidenceCaps.push({ connectionId, modelId, capTokens: capTokens as number, evidence });
  }

  return {
    ok: true,
    value: { revision, profiles, profileByRoleTemplate, profileBySkillCategory, routeEvidenceCaps },
  };
}

/** A complete four-cell row with its own consistency checked; returns the reason as a string when invalid. */
function validateValuesRow(raw: unknown, path: string): SmartCompactionProfileValues | string {
  if (!isRecord(raw)) return `${path} must be an object`;
  const extra = Object.keys(raw).filter((key) => !(PROFILE_VALUE_FIELDS as readonly string[]).includes(key));
  if (extra.length > 0) return `${path} has unknown field(s): ${extra.join(', ')}`;
  for (const field of PROFILE_VALUE_FIELDS) {
    const problem = profileValueProblem(field, raw[field]);
    if (problem) return `${path}.${field} ${problem}`;
  }
  const row: SmartCompactionProfileValues = {
    windowPercent: raw.windowPercent as number,
    ceilingTokens: raw.ceilingTokens as number,
    recentTailTokens: raw.recentTailTokens as number,
    postCompactTargetTokens: raw.postCompactTargetTokens as number,
  };
  const problem = profileRowProblem(row);
  return problem ? `${path}: ${problem}` : row;
}

/**
 * Admit an agent's four compaction fields one by one. An invalid value is dropped and reported; it never
 * rejects the agent. A dropped mode therefore means Smart, and a Custom agent that lost a number resolves as
 * unavailable until the user sets it again.
 */
export function sanitizeAgentCompactionFields(
  raw: Record<string, unknown>,
  path: string,
): { fields: AgentCompactionFields; warnings: string[] } {
  const fields: AgentCompactionFields = {};
  const warnings: string[] = [];
  if (raw.smartCompactionMode !== undefined) {
    if (isSmartCompactionMode(raw.smartCompactionMode)) fields.smartCompactionMode = raw.smartCompactionMode;
    else warnings.push(`${path}.smartCompactionMode was ignored: it must be smart, custom or off.`);
  }
  if (raw.smartCompactionProfile !== undefined) {
    if (isCompactionWorkProfile(raw.smartCompactionProfile)) fields.smartCompactionProfile = raw.smartCompactionProfile;
    else warnings.push(`${path}.smartCompactionProfile was ignored: it must name a known work profile.`);
  }
  if (raw.smartCompactionWindowPercent !== undefined) {
    const problem = profileValueProblem('windowPercent', raw.smartCompactionWindowPercent);
    if (problem) warnings.push(`${path}.smartCompactionWindowPercent was ignored: it ${problem}.`);
    else fields.smartCompactionWindowPercent = raw.smartCompactionWindowPercent as number;
  }
  if (raw.smartCompactionCeilingTokens !== undefined) {
    const problem = profileValueProblem('ceilingTokens', raw.smartCompactionCeilingTokens);
    if (problem) warnings.push(`${path}.smartCompactionCeilingTokens was ignored: it ${problem}.`);
    else fields.smartCompactionCeilingTokens = raw.smartCompactionCeilingTokens as number;
  }
  return { fields, warnings };
}

/**
 * Admit a team's profile-table overrides (design §4.1). Scalar-invalid cells are dropped and reported one by
 * one. A row whose merged values still conflict loses its three token overrides together, keeps any valid
 * window share, and is reported once. Nothing here disables an agent.
 */
export function sanitizeProfileOverrides(
  raw: unknown,
  baseline: Readonly<Record<CompactionWorkProfile, SmartCompactionProfileValues>> | undefined,
  path = 'smartCompactionProfiles',
): { overrides?: SmartCompactionProfileOverrides; warnings: string[] } {
  const warnings: string[] = [];
  if (raw === undefined) return { warnings };
  if (!isRecord(raw)) {
    warnings.push(`${path} was ignored: it must be an object of profile rows.`);
    return { warnings };
  }
  const overrides: SmartCompactionProfileOverrides = {};
  for (const [id, rawRow] of Object.entries(raw)) {
    if (!isCompactionWorkProfile(id)) {
      warnings.push(`${path}.${id} was ignored: it is not a known work profile.`);
      continue;
    }
    if (!isRecord(rawRow)) {
      warnings.push(`${path}.${id} was ignored: it must be an object.`);
      continue;
    }
    const cells: Partial<SmartCompactionProfileValues> = {};
    for (const [field, value] of Object.entries(rawRow)) {
      if (!(PROFILE_VALUE_FIELDS as readonly string[]).includes(field)) {
        warnings.push(`${path}.${id}.${field} was ignored: it is not a profile setting.`);
        continue;
      }
      const problem = profileValueProblem(field as ProfileValueField, value);
      if (problem) {
        warnings.push(`${path}.${id}.${field} was ignored: it ${problem}.`);
        continue;
      }
      cells[field as ProfileValueField] = value as number;
    }
    const base = baseline?.[id];
    if (base) {
      const problem = profileRowProblem({ ...base, ...cells });
      if (problem) {
        for (const field of TOKEN_BUNDLE) delete cells[field];
        warnings.push(`${path}.${id} token overrides were ignored because ${problem}.`);
      }
    }
    if (Object.keys(cells).length > 0) overrides[id] = cells;
  }
  return { overrides: Object.keys(overrides).length > 0 ? overrides : undefined, warnings };
}

/**
 * The editor's stricter check: every problem in a candidate table, so a save is refused and explained rather
 * than silently trimmed. An empty list means the candidate may be saved as-is.
 */
export function profileOverrideProblems(
  candidate: SmartCompactionProfileOverrides,
  baseline: Readonly<Record<CompactionWorkProfile, SmartCompactionProfileValues>>,
): string[] {
  const problems: string[] = [];
  for (const [id, cells] of Object.entries(candidate)) {
    if (!isCompactionWorkProfile(id) || !cells) {
      problems.push(`${id} is not a known work profile.`);
      continue;
    }
    const before = problems.length;
    for (const [field, value] of Object.entries(cells)) {
      if (!(PROFILE_VALUE_FIELDS as readonly string[]).includes(field)) {
        problems.push(`${id}.${field} is not a profile setting.`);
        continue;
      }
      const problem = profileValueProblem(field as ProfileValueField, value);
      if (problem) problems.push(`${profileLabel(id)}: ${fieldLabel(field as ProfileValueField)} ${problem}.`);
    }
    // The row check needs every cell to be a valid number first; its scalar problems are already listed.
    if (problems.length === before) {
      const problem = profileRowProblem({ ...baseline[id], ...cells });
      if (problem) problems.push(`${profileLabel(id)}: ${problem}.`);
    }
  }
  return problems;
}

/**
 * Store an Agent Settings choice, persisting only what differs from the default: Smart with Auto leaves no
 * field at all, and the Custom numbers exist only while the agent is in Custom mode.
 */
export function applySmartCompactionChoice(
  config: AgentCompactionFields,
  choice: { mode: SmartCompactionMode; profile?: CompactionWorkProfile; windowPercent?: number; ceilingTokens?: number },
): void {
  for (const field of AGENT_COMPACTION_FIELDS) delete config[field];
  if (choice.mode === 'smart') {
    if (choice.profile) config.smartCompactionProfile = choice.profile;
    return;
  }
  config.smartCompactionMode = choice.mode;
  if (choice.mode === 'custom') {
    config.smartCompactionWindowPercent = choice.windowPercent;
    config.smartCompactionCeilingTokens = choice.ceilingTokens;
  }
}

/** Explicit profile, then role template, then primary skill category, then balanced (design §4.1). */
export function resolveWorkProfile(
  agent: Pick<AgentConfig, 'roleTemplateKey' | 'skills' | 'smartCompactionProfile'>,
  data: Pick<SmartCompactionPolicyData, 'profileByRoleTemplate' | 'profileBySkillCategory'>,
): { profile: CompactionWorkProfile; source: ProfileResolutionSource } {
  if (isCompactionWorkProfile(agent.smartCompactionProfile)) {
    return { profile: agent.smartCompactionProfile, source: 'agent' };
  }
  const byRole = agent.roleTemplateKey ? data.profileByRoleTemplate[agent.roleTemplateKey] : undefined;
  if (byRole) return { profile: byRole, source: 'role-template' };
  const primary = primarySkill(agent.skills);
  const bySkill = primary ? data.profileBySkillCategory[primary.category] : undefined;
  if (bySkill) return { profile: bySkill, source: 'skill-category' };
  return { profile: 'balanced', source: 'fallback' };
}

/** The first persisted skill whose category is a real one. The legacy free-text `skill` is never parsed. */
export function primarySkill(skills: AgentConfig['skills']): NonNullable<AgentConfig['skills']>[number] | undefined {
  return (skills ?? []).find((skill) => isSkillCategory(skill?.category));
}

/** The candidate table without cells equal to the bundled value: only real overrides are stored. */
export function withoutDefaultCells(
  candidate: SmartCompactionProfileOverrides,
  baseline: Readonly<Record<CompactionWorkProfile, SmartCompactionProfileValues>>,
): SmartCompactionProfileOverrides | undefined {
  const overrides: SmartCompactionProfileOverrides = {};
  for (const id of COMPACTION_WORK_PROFILES) {
    const cells = candidate[id];
    if (!cells) continue;
    const changed = Object.fromEntries(
      Object.entries(cells).filter(([field, value]) => value !== baseline[id][field as ProfileValueField]),
    ) as Partial<SmartCompactionProfileValues>;
    if (Object.keys(changed).length > 0) overrides[id] = changed;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export function resolveSmartCompactionPolicy(input: SmartCompactionResolutionInput): SmartCompactionResolution {
  const { policy, agent } = input;
  // A mode value that does not validate is dropped at every file boundary, where absence means Smart.
  const mode: SmartCompactionMode = isSmartCompactionMode(agent.smartCompactionMode) ? agent.smartCompactionMode : 'smart';
  if (!policy.revision) {
    return { status: 'unavailable', mode, reason: policy.smart.ok ? 'the policy file has no revision' : policy.smart.error };
  }
  const windowShare = (percent: number): number | undefined => input.contextWindow && isPositiveInteger(input.contextWindow.tokens)
    ? Math.floor(input.contextWindow.tokens * percent / 100)
    : undefined;

  if (mode === 'custom') {
    if (!policy.custom.ok) return { status: 'unavailable', mode, reason: policy.custom.error };
    const percent = agent.smartCompactionWindowPercent;
    const ceiling = agent.smartCompactionCeilingTokens;
    if (profileValueProblem('windowPercent', percent) || profileValueProblem('ceilingTokens', ceiling)) {
      return {
        status: 'unavailable',
        mode,
        reason: 'this agent\'s Custom window share or practical ceiling is missing or invalid; choose Reset Custom in Agent Settings',
      };
    }
    const defaults = policy.custom.value;
    const values: SmartCompactionProfileValues = {
      windowPercent: percent as number,
      ceilingTokens: ceiling as number,
      recentTailTokens: defaults.recentTailTokens,
      postCompactTargetTokens: defaults.postCompactTargetTokens,
    };
    const share = windowShare(values.windowPercent);
    const { activeTriggerTokens, winningTerm } = pickTrigger(share, values.ceilingTokens, undefined);
    const ignoredCap = policy.smart.ok ? matchingEvidenceCap(policy.smart.value, input.route) : undefined;
    return {
      status: 'resolved',
      policy: {
        mode,
        revision: policyIdentity({ policyRevision: policy.revision, mode, values, customDefaults: defaults }),
        ...values,
        activeTriggerTokens,
        winningTerm,
      },
      ...(share === undefined ? {} : { windowShareTokens: share }),
      ...(ignoredCap ? { customIgnoresEvidenceCapTokens: ignoredCap.capTokens } : {}),
    };
  }

  if (!policy.smart.ok) {
    if (mode === 'off' && policy.custom.ok) {
      // Off has no automatic trigger. Its values only size a manual Compact, and the Custom defaults are the
      // one validated source left.
      const values = policy.custom.value;
      return {
        status: 'resolved',
        policy: {
          mode,
          revision: policyIdentity({ policyRevision: policy.revision, mode, values, customDefaults: values }),
          ...values,
        },
      };
    }
    return { status: 'unavailable', mode, reason: policy.smart.error };
  }

  const data = policy.smart.value;
  const { profile, source } = resolveWorkProfile(agent, data);
  const cells = input.teamOverrides?.[profile];
  const values = mergeProfileRow(data.profiles[profile], cells);
  const appliedCells = cellsDifferingFrom(data.profiles[profile], values);
  if (mode === 'off') {
    return {
      status: 'resolved',
      policy: {
        mode,
        profile,
        resolutionSource: source,
        revision: policyIdentity({ policyRevision: policy.revision, mode, profile, values, overrides: appliedCells }),
        ...values,
      },
    };
  }
  const cap = matchingEvidenceCap(data, input.route);
  const share = windowShare(values.windowPercent);
  const { activeTriggerTokens, winningTerm } = pickTrigger(share, values.ceilingTokens, cap?.capTokens);
  return {
    status: 'resolved',
    policy: {
      mode,
      profile,
      resolutionSource: source,
      revision: policyIdentity({
        policyRevision: policy.revision,
        mode,
        profile,
        values,
        overrides: appliedCells,
        routeEvidenceCapTokens: cap?.capTokens ?? null,
      }),
      ...values,
      ...(cap ? { routeEvidenceCapTokens: cap.capTokens } : {}),
      activeTriggerTokens,
      winningTerm,
    },
    ...(share === undefined ? {} : { windowShareTokens: share }),
  };
}

/** Design §5: the verbatim tail is at most this share of the active trigger. */
const RECENT_TAIL_TRIGGER_SHARE = 0.30;
/** Design §5: the post-compaction working target is at most this share of the active trigger. */
const POST_COMPACT_TRIGGER_SHARE = 0.45;
/** An automatic host compaction runs only when it can remove at least this share of the active trigger. */
const MIN_AUTOMATIC_GAIN_SHARE = 0.10;

/**
 * The least an automatic host compaction must be able to remove. Below it, a compaction would land just under the
 * trigger and run again on the next turn; skipping it (at no cost) lets enough accumulate first, so the conversation
 * can run past the trigger by at most this share. A manual Compact is never held to it.
 */
export function minimumAutomaticGain(triggerTokens: number): number {
  return Math.floor(triggerTokens * MIN_AUTOMATIC_GAIN_SHARE);
}

/**
 * The verbatim tail and working target a host-history compaction aims for (design §5). Off has no trigger and
 * therefore no automatic sizing.
 */
export function compactionSizing(
  policy: Pick<ResolvedSmartCompactionPolicy, 'activeTriggerTokens' | 'recentTailTokens' | 'postCompactTargetTokens'>,
): { recentTailTokens: number; postCompactTargetTokens: number } | undefined {
  if (policy.activeTriggerTokens === undefined) return undefined;
  return {
    recentTailTokens: Math.min(policy.recentTailTokens, Math.floor(policy.activeTriggerTokens * RECENT_TAIL_TRIGGER_SHARE)),
    postCompactTargetTokens: Math.min(
      policy.postCompactTargetTokens,
      Math.floor(policy.activeTriggerTokens * POST_COMPACT_TRIGGER_SHARE),
    ),
  };
}

/**
 * The trigger that sizes one compaction: the active trigger, or — for a manual Compact while automatic
 * compaction is Off — the rule the agent's values would apply to this window (the smaller of its window share
 * and practical ceiling). Off never schedules a compaction; it still needs a size when the user asks for one.
 */
export function sizingTriggerTokens(
  policy: Pick<ResolvedSmartCompactionPolicy, 'activeTriggerTokens' | 'windowPercent' | 'ceilingTokens'>,
  windowTokens: number | undefined,
): number {
  if (policy.activeTriggerTokens !== undefined) return policy.activeTriggerTokens;
  const share = windowTokens !== undefined && windowTokens > 0 ? Math.floor(windowTokens * policy.windowPercent / 100) : undefined;
  return share === undefined ? policy.ceilingTokens : Math.min(share, policy.ceilingTokens);
}

/** Exact `{ connectionId, normalizedModelId }` match; no alias or prefix matching. */
export function matchingEvidenceCap(
  data: Pick<SmartCompactionPolicyData, 'routeEvidenceCaps'>,
  route: { connectionId: string; modelId: string } | undefined,
): RouteEvidenceCap | undefined {
  if (!route) return undefined;
  const modelId = normalizeModelId(route.modelId);
  return data.routeEvidenceCaps.find((cap) => cap.connectionId === route.connectionId && cap.modelId === modelId);
}

export function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

/**
 * The smallest term wins. Ties go to the earlier term in the order window share, practical ceiling, route
 * evidence cap, so the recorded reason is deterministic.
 */
function pickTrigger(
  windowShareTokens: number | undefined,
  ceilingTokens: number,
  capTokens: number | undefined,
): { activeTriggerTokens: number; winningTerm: TriggerTerm } {
  const terms: Array<[TriggerTerm, number | undefined]> = [
    ['window-share', windowShareTokens],
    ['practical-ceiling', ceilingTokens],
    ['route-evidence-cap', capTokens],
  ];
  let best: [TriggerTerm, number] | undefined;
  for (const [term, tokens] of terms) {
    if (tokens === undefined) continue;
    if (!best || tokens < best[1]) best = [term, tokens];
  }
  // The ceiling is always present, so `best` is always set.
  const [winningTerm, activeTriggerTokens] = best as [TriggerTerm, number];
  return { activeTriggerTokens, winningTerm };
}

/** Bundled row plus a team's cells, with the same conflict rule the file boundary applies. */
export function mergeProfileRow(
  base: SmartCompactionProfileValues,
  cells: Partial<SmartCompactionProfileValues> | undefined,
): SmartCompactionProfileValues {
  const admitted: Partial<SmartCompactionProfileValues> = {};
  for (const field of PROFILE_VALUE_FIELDS) {
    const value = cells?.[field];
    if (value !== undefined && !profileValueProblem(field, value)) admitted[field] = value;
  }
  if (profileRowProblem({ ...base, ...admitted })) {
    for (const field of TOKEN_BUNDLE) delete admitted[field];
  }
  return { ...base, ...admitted };
}

function cellsDifferingFrom(
  base: SmartCompactionProfileValues,
  values: SmartCompactionProfileValues,
): Partial<SmartCompactionProfileValues> {
  const cells: Partial<SmartCompactionProfileValues> = {};
  for (const field of PROFILE_VALUE_FIELDS) {
    if (values[field] !== base[field]) cells[field] = values[field];
  }
  return cells;
}

function policyIdentity(value: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 12);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

const PROFILE_LABELS: Record<CompactionWorkProfile, string> = {
  balanced: 'Balanced',
  'iterative-delivery': 'Iterative delivery',
  'research-synthesis': 'Research & synthesis',
  'qa-debugging': 'QA & debugging',
  'deep-build': 'Deep build',
};

const PROFILE_TYPICAL_WORK: Record<CompactionWorkProfile, string> = {
  balanced: 'Mixed, unknown, coordinator or custom work',
  'iterative-delivery': 'Coding, content production, documentation, routine file delivery',
  'research-synthesis': 'Market and UX research, analysis, evidence synthesis',
  'qa-debugging': 'Testing, review, incident analysis, repeated experiments',
  'deep-build': 'Architecture, greenfield construction, migration, exact-source-heavy work',
};

export function profileLabel(profile: CompactionWorkProfile): string {
  return PROFILE_LABELS[profile];
}

export function profileTypicalWork(profile: CompactionWorkProfile): string {
  return PROFILE_TYPICAL_WORK[profile];
}

export function fieldLabel(field: ProfileValueField): string {
  switch (field) {
    case 'windowPercent': return 'window share';
    case 'ceilingTokens': return 'practical ceiling';
    case 'recentTailTokens': return 'recent tail';
    case 'postCompactTargetTokens': return 'post-compact target';
  }
}

export function formatTokens(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
