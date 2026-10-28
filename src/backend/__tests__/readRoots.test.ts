import { describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { normalizeAgentReadRoots } from '../readRoots';

describe('normalizeAgentReadRoots', () => {
  it('ignores additionalRoots when the workspace is untrusted', async () => {
    const primary = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-roots-primary-'));
    const workspaceSecond = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-roots-workspace-'));
    const additional = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-roots-additional-'));

    try {
      const trusted = normalizeAgentReadRoots(primary, [primary, workspaceSecond], [additional], true);
      expect(trusted.map((p) => path.resolve(p))).toContain(path.resolve(workspaceSecond));
      expect(trusted.map((p) => path.resolve(p))).toContain(path.resolve(additional));

      const untrusted = normalizeAgentReadRoots(primary, [primary, workspaceSecond], [additional], false);
      expect(untrusted.map((p) => path.resolve(p))).toContain(path.resolve(workspaceSecond));
      expect(untrusted.map((p) => path.resolve(p))).not.toContain(path.resolve(additional));
    } finally {
      await fs.rm(primary, { recursive: true, force: true });
      await fs.rm(workspaceSecond, { recursive: true, force: true });
      await fs.rm(additional, { recursive: true, force: true });
    }
  });

  // v0.9.97 P1: a folder whose name starts with two dots is inside the primary root, so it adds no root of its own;
  // a sibling whose name starts like the primary root's is another root (the file-effects design, section 5).
  it('drops a "..name" folder of the primary root as redundant, and keeps a sibling whose name starts like it', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-roots-dots-')));
    try {
      const primary = path.join(base, 'repo');
      const dotted = path.join(primary, '..cache');
      const sibling = path.join(base, 'repo-cache');
      await fs.mkdir(dotted, { recursive: true });
      await fs.mkdir(sibling);
      expect(normalizeAgentReadRoots(primary, [primary, dotted, sibling], [], true)).toEqual([sibling]);
      expect(normalizeAgentReadRoots(dotted, [primary], [], true)).toEqual([primary]);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
