import { existsSync, realpathSync } from 'node:fs';
import * as path from 'path';
import { isPathInsideOrEqual } from './pathContainment';

export function normalizeAgentReadRoots(
  primaryRoot: string,
  workspaceRoots: string[],
  additionalRoots: string[],
  isTrusted: boolean
): string[] {
  const primary = path.resolve(primaryRoot);
  const roots = [primary, ...workspaceRoots, ...(isTrusted ? additionalRoots : [])];
  return normalizeReadRoots(roots).filter((root) => path.resolve(root) !== primary);
}

function normalizeReadRoots(roots: string[]): string[] {
  const resolved: string[] = [];
  for (const raw of roots) {
    try {
      const abs = path.resolve(raw);
      if (!existsSync(abs)) { continue; }
      const real = realpathSync(abs);
      if (!resolved.includes(real)) { resolved.push(real); }
    } catch {
      // Ignore malformed or inaccessible configured roots.
    }
  }
  resolved.sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const root of resolved) {
    if (!kept.some((parent) => isPathInsideOrEqual(parent, root))) {
      kept.push(root);
    }
  }
  return kept;
}
