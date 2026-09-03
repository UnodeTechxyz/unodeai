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
});
