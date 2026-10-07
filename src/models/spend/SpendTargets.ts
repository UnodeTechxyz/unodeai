/*---------------------------------------------------------------------------------------------
 *  UnodeAi - spend reminder targets (v0.9.89, design §6, §13.2, §13.6)
 *
 *  User targets come only from application-scoped User Settings. A repository file may propose LOWER values
 *  for reminders the user already enabled; it has no effect until the user accepts its exact digest. Nothing
 *  here can enable a reminder, choose a catalog, pick a period or zone, or reset a counter from repository input.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { visit, type ParseError, printParseErrorCode } from 'jsonc-parser';
import { canonicalJson } from './SpendTypes';
import { formatTargetUsd, parseTargetUsd } from './Money';
import type { StoredReferencePriceMode } from './PriceResolver';

export const MAX_TARGET_TOKENS = 1_000_000_000_000;
export const MAX_BUDGET_FILE_BYTES = 64 * 1024;
const AGENT_ID = /^[A-Za-z0-9._:@-]{1,128}$/;
const MAX_AGENT_ENTRIES = 200;

export interface SpendTargetValue {
  tokens?: number;
  usd?: string;
}

export interface SpendTargetSettingsV1 {
  schemaVersion: 1;
  request?: SpendTargetValue;
  project?: SpendTargetValue & { period: 'day' | 'month'; timeZone: string };
  agents?: Record<string, SpendTargetValue>;
}

/** A validated dimension pair. `nanoUsd` is exact; either may be absent. */
export interface TargetAmounts {
  tokens?: number;
  nanoUsd?: bigint;
}

export interface UserTargets {
  request?: TargetAmounts;
  project?: TargetAmounts & { period: 'day' | 'month'; timeZone: string };
  agents: Record<string, TargetAmounts>;
  diagnostics: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validTokens(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_TARGET_TOKENS;
}

/** Each dimension validates on its own: a bad dollar value disables only the dollar target. */
function parseAmounts(raw: unknown, where: string, diagnostics: string[]): TargetAmounts | undefined {
  if (!isObject(raw)) {
    if (raw !== undefined) diagnostics.push(`${where}: not an object; ignored.`);
    return undefined;
  }
  const out: TargetAmounts = {};
  if (raw.tokens !== undefined) {
    if (validTokens(raw.tokens)) out.tokens = raw.tokens;
    else diagnostics.push(`${where}.tokens: must be a whole number from 1 to 1,000,000,000,000; ignored.`);
  }
  if (raw.usd !== undefined) {
    const nano = parseTargetUsd(raw.usd);
    if (nano !== undefined) out.nanoUsd = nano;
    else diagnostics.push(`${where}.usd: must be a decimal string from "0.000001" to "1000000.000000"; ignored.`);
  }
  return out.tokens !== undefined || out.nanoUsd !== undefined ? out : undefined;
}

export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Validate `unode.spend.targets`. Invalid fields disable only that entry and are named in diagnostics. */
export function parseUserTargets(raw: unknown): UserTargets {
  const diagnostics: string[] = [];
  const out: UserTargets = { agents: {}, diagnostics };
  if (raw === undefined || raw === null) return out;
  if (!isObject(raw)) {
    diagnostics.push('unode.spend.targets: not an object; every reminder is off.');
    return out;
  }
  if (raw.schemaVersion !== 1) {
    diagnostics.push('unode.spend.targets: schemaVersion must be 1; every reminder is off.');
    return out;
  }
  const request = parseAmounts(raw.request, 'request', diagnostics);
  if (request) out.request = request;
  if (raw.project !== undefined) {
    const project = parseAmounts(raw.project, 'project', diagnostics);
    const shape = isObject(raw.project) ? raw.project : {};
    const period = shape.period;
    if (project && (period === 'day' || period === 'month') && isValidTimeZone(shape.timeZone)) {
      out.project = { ...project, period, timeZone: shape.timeZone };
    } else if (project) {
      diagnostics.push('project: needs period "day" or "month" and a valid IANA timeZone; the project target is off.');
    }
  }
  if (raw.agents !== undefined) {
    if (!isObject(raw.agents)) {
      diagnostics.push('agents: not an object; ignored.');
    } else if (!out.project) {
      if (Object.keys(raw.agents).length > 0) diagnostics.push('agents: shares apply only inside a project target; ignored.');
    } else {
      for (const [agentId, value] of Object.entries(raw.agents).slice(0, MAX_AGENT_ENTRIES)) {
        if (!AGENT_ID.test(agentId)) { diagnostics.push(`agents: "${agentId.slice(0, 40)}" is not an agent id; ignored.`); continue; }
        const amounts = parseAmounts(value, `agents.${agentId}`, diagnostics);
        if (amounts) out.agents[agentId] = amounts;
      }
    }
  }
  return out;
}

/** Serialize validated user targets back to the settings shape (the Settings panel writes the whole object). */
export function userTargetsToSettings(targets: Omit<UserTargets, 'diagnostics'>): SpendTargetSettingsV1 {
  const value = (amounts: TargetAmounts): SpendTargetValue => ({
    ...(amounts.tokens !== undefined ? { tokens: amounts.tokens } : {}),
    ...(amounts.nanoUsd !== undefined ? { usd: formatTargetUsd(amounts.nanoUsd) } : {}),
  });
  return {
    schemaVersion: 1,
    ...(targets.request ? { request: value(targets.request) } : {}),
    ...(targets.project ? { project: { ...value(targets.project), period: targets.project.period, timeZone: targets.project.timeZone } } : {}),
    ...(Object.keys(targets.agents).length > 0
      ? { agents: Object.fromEntries(Object.entries(targets.agents).map(([id, amounts]) => [id, value(amounts)])) }
      : {}),
  };
}

// ─── Repository proposal (.unode/budget.json) ─────────────────────────────────────

export interface RepositoryBudget {
  request?: TargetAmounts;
  project?: TargetAmounts;
  agents: Record<string, TargetAmounts>;
  /** SHA-256 of the canonical validated content: what an acceptance binds to. */
  contentDigest: string;
  unknownKeys: string[];
}

export type RepositoryBudgetParse =
  | { ok: true; budget: RepositoryBudget }
  | { ok: false; reason: string };

/**
 * Parse `.unode/budget.json` as attacker-controlled input: strict JSON (no comments or trailing commas), no
 * duplicate keys at any depth, no arrays, no exponent/negative/non-integer token counts, bounded ids and size.
 */
export function parseRepositoryBudget(text: string): RepositoryBudgetParse {
  if (Buffer.byteLength(text, 'utf8') > MAX_BUDGET_FILE_BYTES) return { ok: false, reason: 'the file is larger than 64 KiB' };
  const errors: ParseError[] = [];
  const stack: Array<Set<string>> = [];
  let failure: string | undefined;
  visit(text, {
    onObjectBegin: () => { stack.push(new Set()); },
    onObjectEnd: () => { stack.pop(); },
    onObjectProperty: (property) => {
      const keys = stack[stack.length - 1];
      if (keys?.has(property)) failure ??= `duplicate key "${property.slice(0, 40)}"`;
      keys?.add(property);
    },
    onArrayBegin: () => { failure ??= 'arrays are not allowed'; },
    onLiteralValue: (value, offset, length) => {
      if (typeof value === 'number') {
        const raw = text.slice(offset, offset + length);
        if (/[eE]/.test(raw)) failure ??= 'exponent notation is not allowed';
        if (raw.startsWith('-')) failure ??= 'negative numbers are not allowed';
        if (!Number.isFinite(value)) failure ??= 'non-finite numbers are not allowed';
      }
    },
    onComment: () => { failure ??= 'comments are not allowed'; },
    onError: (error) => { errors.push({ error, offset: 0, length: 0 }); },
  }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  if (errors.length > 0) return { ok: false, reason: `not valid JSON (${printParseErrorCode(errors[0].error)})` };
  if (failure) return { ok: false, reason: failure };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, reason: 'not valid JSON' }; }
  if (!isObject(parsed)) return { ok: false, reason: 'the top level must be an object' };
  if (parsed.schemaVersion !== 1) return { ok: false, reason: 'schemaVersion must be 1' };
  const unknownKeys: string[] = [];
  for (const key of Object.keys(parsed)) if (key !== 'schemaVersion' && key !== 'max') unknownKeys.push(key);
  if (!isObject(parsed.max)) return { ok: false, reason: '"max" must be an object' };
  const max = parsed.max;
  for (const key of Object.keys(max)) if (!['request', 'project', 'agents'].includes(key)) unknownKeys.push(`max.${key}`);
  const strictAmounts = (value: unknown, where: string): TargetAmounts | string | undefined => {
    if (value === undefined) return undefined;
    if (!isObject(value)) return `${where} must be an object`;
    for (const key of Object.keys(value)) if (key !== 'tokens' && key !== 'usd') unknownKeys.push(`${where}.${key}`);
    const out: TargetAmounts = {};
    if (value.tokens !== undefined) {
      if (!validTokens(value.tokens)) return `${where}.tokens must be a whole number from 1 to 1,000,000,000,000`;
      out.tokens = value.tokens;
    }
    if (value.usd !== undefined) {
      const nano = parseTargetUsd(value.usd);
      if (nano === undefined) return `${where}.usd must be a decimal string from "0.000001" to "1000000.000000"`;
      out.nanoUsd = nano;
    }
    return out;
  };
  const request = strictAmounts(max.request, 'max.request');
  if (typeof request === 'string') return { ok: false, reason: request };
  const project = strictAmounts(max.project, 'max.project');
  if (typeof project === 'string') return { ok: false, reason: project };
  const agents: Record<string, TargetAmounts> = {};
  if (max.agents !== undefined) {
    if (!isObject(max.agents)) return { ok: false, reason: 'max.agents must be an object' };
    const entries = Object.entries(max.agents);
    if (entries.length > MAX_AGENT_ENTRIES) return { ok: false, reason: 'too many agent entries' };
    for (const [agentId, value] of entries) {
      if (!AGENT_ID.test(agentId)) return { ok: false, reason: 'an agent id is not valid' };
      const amounts = strictAmounts(value, `max.agents.${agentId}`);
      if (typeof amounts === 'string') return { ok: false, reason: amounts };
      if (amounts) agents[agentId] = amounts;
    }
  }
  const canonical = {
    schemaVersion: 1,
    max: {
      ...(request ? { request: amountsJson(request) } : {}),
      ...(project ? { project: amountsJson(project) } : {}),
      ...(Object.keys(agents).length > 0
        ? { agents: Object.fromEntries(Object.entries(agents).map(([id, amounts]) => [id, amountsJson(amounts)])) }
        : {}),
    },
  };
  return {
    ok: true,
    budget: {
      ...(request && (request.tokens !== undefined || request.nanoUsd !== undefined) ? { request } : {}),
      ...(project && (project.tokens !== undefined || project.nanoUsd !== undefined) ? { project } : {}),
      agents,
      contentDigest: createHash('sha256').update(canonicalJson(canonical)).digest('hex'),
      unknownKeys,
    },
  };
}

function amountsJson(amounts: TargetAmounts): Record<string, unknown> {
  return {
    ...(amounts.tokens !== undefined ? { tokens: amounts.tokens } : {}),
    ...(amounts.nanoUsd !== undefined ? { usd: formatTargetUsd(amounts.nanoUsd) } : {}),
  };
}

// ─── Effective targets ───────────────────────────────────────────────────────────

export interface EffectiveAmount {
  value: number | bigint;
  /** The accepted repository value is lower than the user's and is in force. */
  repositoryNarrowed: boolean;
}

export interface EffectiveTargets {
  request: { tokens?: EffectiveAmount; nanoUsd?: EffectiveAmount };
  project?: { tokens?: EffectiveAmount; nanoUsd?: EffectiveAmount; period: 'day' | 'month'; timeZone: string };
  agents: Record<string, { tokens?: EffectiveAmount; nanoUsd?: EffectiveAmount }>;
  /** The repository proposal in force, if any (accepted and matching its digest). */
  appliedRepositoryDigest?: string;
}

function narrow<T extends number | bigint>(user: T | undefined, repository: T | undefined): EffectiveAmount | undefined {
  if (user === undefined) return undefined; // A repository value can never enable a dimension.
  if (repository !== undefined && repository < user) return { value: repository, repositoryNarrowed: true };
  return { value: user, repositoryNarrowed: false };
}

function narrowAmounts(user: TargetAmounts | undefined, repository: TargetAmounts | undefined) {
  const tokens = narrow(user?.tokens, repository?.tokens);
  const nanoUsd = narrow(user?.nanoUsd, repository?.nanoUsd);
  return { ...(tokens ? { tokens } : {}), ...(nanoUsd ? { nanoUsd } : {}) };
}

/**
 * The lower of each enabled user dimension and an ACCEPTED repository value. Missing, invalid, changed,
 * unaccepted or ignored repository input returns the user targets unchanged.
 */
export function effectiveTargets(
  user: UserTargets,
  repository: RepositoryBudget | undefined,
  acceptedDigest: string | undefined,
): EffectiveTargets {
  const applied = repository && acceptedDigest && repository.contentDigest === acceptedDigest ? repository : undefined;
  const agents: EffectiveTargets['agents'] = {};
  if (user.project) {
    for (const [agentId, amounts] of Object.entries(user.agents)) {
      const narrowed = narrowAmounts(amounts, applied?.agents[agentId]);
      if (narrowed.tokens || narrowed.nanoUsd) agents[agentId] = narrowed;
    }
  }
  return {
    request: narrowAmounts(user.request, applied?.request),
    ...(user.project
      ? { project: { ...narrowAmounts(user.project, applied?.project), period: user.project.period, timeZone: user.project.timeZone } }
      : {}),
    agents,
    ...(applied ? { appliedRepositoryDigest: applied.contentDigest } : {}),
  };
}

/**
 * `targetRevision`: a digest of the effective targets and the stored reference mode (design §13.6). Changing any
 * target, the accepted repository narrowing or the mode starts a new alert ladder. No path or secret enters it.
 */
export function targetRevision(targets: EffectiveTargets, referenceMode: StoredReferencePriceMode): string {
  const amount = (value?: EffectiveAmount) => value === undefined ? undefined : { v: String(value.value), r: value.repositoryNarrowed };
  const dims = (entry?: { tokens?: EffectiveAmount; nanoUsd?: EffectiveAmount }) =>
    entry ? { t: amount(entry.tokens), u: amount(entry.nanoUsd) } : undefined;
  const payload = {
    request: dims(targets.request),
    project: targets.project ? { ...dims(targets.project), p: targets.project.period, z: targets.project.timeZone } : undefined,
    agents: Object.fromEntries(Object.keys(targets.agents).sort().map((id) => [id, dims(targets.agents[id])])),
    repository: targets.appliedRepositoryDigest,
    referenceMode,
  };
  return createHash('sha256').update(canonicalJson(payload)).digest('hex').slice(0, 32);
}

const dayFormatters = new Map<string, Intl.DateTimeFormat | null>();
/** Views ask for the period of every recorded event; a zone's day never changes within one minute. */
const dayByMinute = new Map<string, string | null>();
const DAY_CACHE_LIMIT = 100_000;

function dayOf(ms: number, timeZone: string): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  const key = `${timeZone}|${Math.floor(ms / 60_000)}`;
  const cached = dayByMinute.get(key);
  if (cached !== undefined) return cached ?? undefined;
  let formatter = dayFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = isValidTimeZone(timeZone)
      ? new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      : null;
    dayFormatters.set(timeZone, formatter);
  }
  let day: string | null = null;
  if (formatter) {
    const parts = formatter.formatToParts(new Date(ms));
    const get = (type: string) => parts.find((part) => part.type === type)?.value;
    const year = get('year');
    const month = get('month');
    const date = get('day');
    day = year && month && date ? `${year}-${month}-${date}` : null;
  }
  if (dayByMinute.size >= DAY_CACHE_LIMIT) dayByMinute.clear();
  dayByMinute.set(key, day);
  return day ?? undefined;
}

/** Day ids are `YYYY-MM-DD@<IANA>`, month ids `YYYY-MM@<IANA>`, computed in the target's own zone. */
export function periodIdFor(at: number | Date, period: 'day' | 'month', timeZone: string): string | undefined {
  const day = dayOf(at instanceof Date ? at.getTime() : at, timeZone);
  if (!day) return undefined;
  return period === 'day' ? `${day}@${timeZone}` : `${day.slice(0, 7)}@${timeZone}`;
}

/** The machine's current IANA zone, proposed (never silently applied) when the user creates a project target. */
export function currentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
