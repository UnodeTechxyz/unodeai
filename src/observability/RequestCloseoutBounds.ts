/*---------------------------------------------------------------------------------------------
 *  UnodeAi - request closeout bounds (v0.9.94)
 *  The bounds of a request closeout record and the one way a list is cut to its bound. A leaf module: it
 *  imports nothing, so the run ledger can read it without depending on any projection.
 *--------------------------------------------------------------------------------------------*/

/** Far above any real turn; a stored counter beyond it is not a count this host wrote. */
export const MAX_REQUEST_COUNT = 100_000;
export const MAX_CHANGED_FILES = 50;
export const MAX_ROUTE_AGENTS = 12;
export const MAX_RUN_HANDLES = 20;
export const MAX_USAGE_UNITS = 16;

/**
 * Keep the first entries and the last one when a list is over its bound, and say how many were left out. The
 * choice is by position only, so the same observations always keep the same entries.
 */
export function boundedObservations<T>(items: readonly T[], limit: number): { kept: T[]; omitted: number } {
  if (items.length <= limit) return { kept: [...items], omitted: 0 };
  return { kept: [...items.slice(0, limit - 1), items[items.length - 1]], omitted: items.length - limit };
}
