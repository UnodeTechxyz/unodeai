import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * v0.9.97 FOPEN, defence in depth (SECURITY.md "Chat file links open through one host boundary": "A relative path is
 * read against a folder recorded with the reply"). The link classifier refuses every `..` segment, so this check is
 * never reached in production. If the classifier ever let a parent through, the boundary must still not read the
 * link outside the reply's own folder, even where the agent's read folders would allow it.
 */
vi.mock('../../../views/fileLinks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../views/fileLinks')>();
  return {
    ...actual,
    classifyLinkDestination: (destination: string) => destination === 'parent-escape'
      ? { kind: 'file', path: `..${path.sep}outside.md`, absolute: false }
      : actual.classifyLinkDestination(destination),
  };
});

import { agentConfig, navigationHost, tempFolder } from '../../../views/__tests__/support/fileNavigationHost';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });

describe('the reply folder bounds a relative link even if the classifier failed', () => {
  it('refuses a parent of the recorded folder that the agent could read', async () => {
    const made = tempFolder({ 'outside.md': 'in the workspace, outside the reply folder', 'sub/inside.md': 'inside' });
    cleanups.push(made.cleanup);
    const sub = path.join(made.root, 'sub');
    const host = navigationHost([made.root], [agentConfig('dev')]);

    await host.adapter.openFileReference('dev', { destination: 'parent-escape', roots: [sub], ceilings: [made.root], stillShown: () => true });
    await host.adapter.openFileReference('dev', { destination: 'inside.md', roots: [sub], ceilings: [made.root], stillShown: () => true });

    expect(host.opened).toEqual([{ path: path.join(sub, 'inside.md') }]);
    expect(host.notices).toEqual([{
      message: '"parent-escape" is outside this agent\'s current read folders, so UnodeAi did not open it.',
      reference: 'parent-escape',
    }]);
  });
});
