/**
 * Display-only provider ordering shared by every connection picker.
 *
 * Keep unranked entries in their input order: the connection registry remains the authority for
 * their relative order, and this helper must never change a selected/default connection id.
 */
export const PROVIDER_RANK = (id: string): number => id === 'unode' ? 0 : id === 'roam' ? 1 : 2;

export function stableProviderSort<T>(items: readonly T[], idOf: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => PROVIDER_RANK(idOf(a.item)) - PROVIDER_RANK(idOf(b.item)) || a.index - b.index)
    .map(({ item }) => item);
}
