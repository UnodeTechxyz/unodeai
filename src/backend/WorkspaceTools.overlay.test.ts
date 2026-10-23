/**
 * Worktree fan-out: read overlay. In worktree mode an agent works in its OWN isolated worktree but
 * can READ the team's merged work from the integration worktree (the `sharedReadRoot`). Writes always
 * stay in the agent's own root — it can read a teammate's file but not clobber the shared copy.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceTools } from './WorkspaceTools';

/** Build WorkspaceTools with an own root + a read-only shared overlay root (positional arg #16). */
function makeTools(root: string, shared: string | undefined, allowed: string[] = ['read', 'write']) {
  return new WorkspaceTools(
    root,
    new Set(allowed),
    'agent',
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    shared, // sharedReadRoot
  );
}

async function twoRoots(): Promise<{ own: string; shared: string; cleanup: () => Promise<void> }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-overlay-'));
  const own = path.join(base, 'own');
  const shared = path.join(base, 'shared');
  await fs.mkdir(own);
  await fs.mkdir(shared);
  return { own, shared, cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}

describe('WorkspaceTools read overlay (worktree fan-out)', () => {
  it('reads a teammate\'s file from the shared overlay when absent locally, marked read-only', async () => {
    const { own, shared, cleanup } = await twoRoots();
    try {
      await fs.writeFile(path.join(shared, 'featureB.txt'), 'B from teammate\n', 'utf8');
      const tools = makeTools(own, shared);
      const out = await tools.runText('read_file', { path: 'featureB.txt' });
      expect(out).toContain('B from teammate');
      expect(out).toMatch(/read-only/i);
    } finally { await cleanup(); }
  });

  it('prefers the agent\'s own copy over the shared one on a name clash', async () => {
    const { own, shared, cleanup } = await twoRoots();
    try {
      await fs.writeFile(path.join(own, 'featureA.txt'), 'A — my work\n', 'utf8');
      await fs.writeFile(path.join(shared, 'featureA.txt'), 'A — stale shared\n', 'utf8');
      const tools = makeTools(own, shared);
      const out = await tools.runText('read_file', { path: 'featureA.txt' });
      expect(out).toContain('A — my work');
      expect(out).not.toContain('stale shared');
      expect(out).not.toMatch(/read-only/i); // own copy → no shared marker
    } finally { await cleanup(); }
  });

  it('list_dir unions own + shared entries', async () => {
    const { own, shared, cleanup } = await twoRoots();
    try {
      await fs.writeFile(path.join(own, 'featureA.txt'), 'A\n', 'utf8');
      await fs.writeFile(path.join(shared, 'featureB.txt'), 'B\n', 'utf8');
      await fs.writeFile(path.join(shared, 'base.txt'), 'base\n', 'utf8');
      const tools = makeTools(own, shared);
      const out = await tools.runText('list_dir', { path: '.' });
      expect(out).toContain('featureA.txt'); // own
      expect(out).toContain('featureB.txt'); // shared overlay
      expect(out).toContain('base.txt');     // shared overlay
    } finally { await cleanup(); }
  });

  it('write_file always lands in the agent\'s OWN root, never the shared overlay', async () => {
    const { own, shared, cleanup } = await twoRoots();
    try {
      await fs.writeFile(path.join(shared, 'featureB.txt'), 'B from teammate\n', 'utf8');
      const tools = makeTools(own, shared);
      const res = await tools.runText('write_file', { path: 'featureB.txt', content: 'B — my fork\n' });
      expect(res).toMatch(/Wrote/);
      // Own copy created; shared copy untouched.
      expect(await fs.readFile(path.join(own, 'featureB.txt'), 'utf8')).toContain('my fork');
      expect(await fs.readFile(path.join(shared, 'featureB.txt'), 'utf8')).toContain('from teammate');
    } finally { await cleanup(); }
  });

  it('without an overlay, a teammate\'s file is simply not found (no leak)', async () => {
    const { own, shared, cleanup } = await twoRoots();
    try {
      await fs.writeFile(path.join(shared, 'featureB.txt'), 'B\n', 'utf8');
      const tools = makeTools(own, undefined); // overlay off
      const out = await tools.runText('read_file', { path: 'featureB.txt' });
      expect(out).toMatch(/not found/i);
    } finally { await cleanup(); }
  });

  it('a missing file is still a not-found hint even with an overlay', async () => {
    const { own, shared, cleanup } = await twoRoots();
    try {
      const tools = makeTools(own, shared);
      const out = await tools.runText('read_file', { path: 'nope.txt' });
      expect(out).toMatch(/not found/i);
    } finally { await cleanup(); }
  });
});
