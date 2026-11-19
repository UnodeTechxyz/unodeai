/**
 * Pure key-selection for "UnodeAi: Reset Workspace State". Given every workspaceState key, return
 * the ones to delete: the fixed keys plus any whose name starts with one of the per-agent prefixes
 * (conversation snapshots, chat history). Kept vscode-free so it's unit-testable.
 */
export function keysToReset(
  allKeys: readonly string[],
  fixedKeys: readonly string[],
  prefixes: readonly string[]
): string[] {
  const out = new Set<string>(fixedKeys);
  for (const key of allKeys) {
    if (prefixes.some((p) => key.startsWith(p))) {
      out.add(key);
    }
  }
  return [...out];
}
