/*---------------------------------------------------------------------------------------------
 * v0.9.96: Codex account models, remembered per program and version. A list belongs to the executable that returned
 * it; another executable, a newer version of the same one, or the version-only list of 0.9.95 is not offered as its
 * list. A cached list is a suggestion to refresh, never proof of what the account may use now.
 *--------------------------------------------------------------------------------------------*/

import type { CodexAccountModel } from './CodexModelLoader';

export const CODEX_MODEL_CACHE_KEY_V2 = 'unode.codex.accountModels.v2';
const MAX_ENTRIES = 8;
const MAX_MODELS = 200;

export interface CodexModelCacheEntry {
  /** The program that returned the list, as resolved when it ran. */
  program: string;
  cliVersion: string;
  capturedAt: string;
  models: CodexAccountModel[];
}

export interface CodexModelCacheV2 {
  version: 2;
  entries: CodexModelCacheEntry[];
}

export const EMPTY_CODEX_MODEL_CACHE: CodexModelCacheV2 = { version: 2, entries: [] };

/** Anything malformed, or the 0.9.95 record keyed by version alone, reads as empty. */
export function restoreCodexModelCacheV2(value: unknown): CodexModelCacheV2 {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 2) return { version: 2, entries: [] };
  const raw = (value as { entries?: unknown }).entries;
  if (!Array.isArray(raw)) return { version: 2, entries: [] };
  const entries = raw.flatMap((entry): CodexModelCacheEntry[] => {
    if (!entry || typeof entry !== 'object') return [];
    const { program, cliVersion, capturedAt, models } = entry as Record<string, unknown>;
    if (typeof program !== 'string' || !program || program.length > 1024) return [];
    if (typeof cliVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(cliVersion)) return [];
    if (typeof capturedAt !== 'string' || Number.isNaN(Date.parse(capturedAt)) || !Array.isArray(models)) return [];
    const valid = models.flatMap((model): CodexAccountModel[] => {
      if (!model || typeof model.id !== 'string' || typeof model.name !== 'string') return [];
      return [{ id: model.id, name: model.name, vision: model.vision === true, isDefault: model.isDefault === true }];
    }).slice(0, MAX_MODELS);
    return valid.length ? [{ program, cliVersion, capturedAt, models: valid }] : [];
  }).slice(0, MAX_ENTRIES);
  return { version: 2, entries };
}

/** The newest list replaces the program's earlier one; the oldest programs give way first. */
export function rememberCodexModels(
  cache: CodexModelCacheV2,
  entry: CodexModelCacheEntry,
  samePath: (a: string, b: string) => boolean,
): CodexModelCacheV2 {
  const others = cache.entries.filter((existing) => !samePath(existing.program, entry.program));
  return { version: 2, entries: [{ ...entry, models: entry.models.slice(0, MAX_MODELS) }, ...others].slice(0, MAX_ENTRIES) };
}

/**
 * The list of exactly this program. When UnodeAi has since measured the program at another version, its list is
 * of the earlier version and is not offered.
 */
export function cachedCodexModelsFor(
  cache: CodexModelCacheV2,
  program: string | undefined,
  measuredVersion: string | undefined,
  samePath: (a: string, b: string) => boolean,
): CodexModelCacheEntry | undefined {
  if (!program) return undefined;
  const entry = cache.entries.find((candidate) => samePath(candidate.program, program));
  if (!entry || (measuredVersion && measuredVersion !== entry.cliVersion)) return undefined;
  return entry;
}
