import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { localReadRootsForScope, SessionLocalReadScopeConsent } from '../localReadScope';

describe('localReadRootsForScope', () => {
  const workspace = path.join(path.parse(process.cwd()).root, 'work', 'unode');

  it('keeps the workspace-only boundary when selected or unknown', () => {
    expect(localReadRootsForScope('workspace', workspace, true)).toEqual([]);
    expect(localReadRootsForScope(undefined, workspace, true)).toEqual([]);
  });

  it('adds only the immediate parent for sibling-project discovery', () => {
    expect(localReadRootsForScope('parent', workspace, true)).toEqual([path.dirname(workspace)]);
  });

  it('adds the current filesystem volume only after Workspace Trust', () => {
    expect(localReadRootsForScope('volume', workspace, true)).toEqual([path.parse(workspace).root]);
    expect(localReadRootsForScope('parent', workspace, false)).toEqual([]);
    expect(localReadRootsForScope('volume', workspace, false)).toEqual([]);
  });

  it('coalesces concurrent decisions and remembers a decline for this session only', async () => {
    const requests: string[] = [];
    const consent = new SessionLocalReadScopeConsent(async (root) => {
      requests.push(root);
      return false;
    });
    const root = path.dirname(workspace);

    await expect(Promise.all([consent.ensure(root), consent.ensure(root)])).resolves.toEqual([false, false]);
    await expect(consent.ensure(root)).resolves.toBe(false);
    expect(requests).toEqual([root]);
  });

  it('fails closed when a host cannot show the confirmation', async () => {
    const consent = new SessionLocalReadScopeConsent(async () => {
      throw new Error('window unavailable');
    });

    await expect(consent.ensure(workspace)).resolves.toBe(false);
  });
});
