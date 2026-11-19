/*---------------------------------------------------------------------------------------------
 *  One ordering rule for every catalogue list a person has to scan by eye.
 *
 *  Catalogue order is authoring order: it means something to whoever wrote the catalogue and nothing
 *  to someone hunting for "Playwright" in a list of ninety. Alphabetical is the only order a reader
 *  can predict without being told what the order is.
 *--------------------------------------------------------------------------------------------*/

/** Locale-aware, case-insensitive, and numeric so "Agent 10" follows "Agent 9" rather than "Agent 1". */
export function byDisplayName(left: string, right: string): number {
  return String(left ?? '').localeCompare(String(right ?? ''), undefined, { sensitivity: 'base', numeric: true });
}
