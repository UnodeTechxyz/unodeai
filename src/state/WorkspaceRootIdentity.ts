import { createHash } from 'node:crypto';
import * as path from 'node:path';

/**
 * Stable, non-reversible identity for the activation-bound primary workspace root.
 * Every project-state boundary uses this one canonicalization routine.
 */
export function workspaceRootIdentity(root: string): string {
  const normalized = path.resolve(root).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  return createHash('sha256').update(normalized).digest('hex');
}
