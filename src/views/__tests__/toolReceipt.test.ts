import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { resolveRecordedFileForOpen } from '../toolReceipt';

describe('recorded tool-receipt file opening', () => {
  const root = path.resolve('workspace');
  const realpath = (candidate: string) => path.resolve(candidate);

  it('opens a relative host-recorded path inside the agent read roots', () => {
    expect(resolveRecordedFileForOpen('docs/guide.md', root, [root], realpath)).toEqual({
      ok: true,
      path: path.resolve(root, 'docs/guide.md'),
    });
  });

  it('refuses an absolute path outside the agent read roots', () => {
    const outside = path.resolve('private', 'secret.md');
    expect(resolveRecordedFileForOpen(outside, root, [root], realpath)).toEqual({
      ok: false,
      reason: 'outside-read-roots',
    });
  });

  it('compares the physical target so a symlink cannot escape the read root', () => {
    const linked = path.resolve(root, 'docs', 'linked.md');
    const outside = path.resolve('private', 'secret.md');
    const resolvingSymlink = (candidate: string) => path.resolve(candidate) === linked ? outside : path.resolve(candidate);

    expect(resolveRecordedFileForOpen('docs/linked.md', root, [root], resolvingSymlink)).toEqual({
      ok: false,
      reason: 'outside-read-roots',
    });
  });
});
