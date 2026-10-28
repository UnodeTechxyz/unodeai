import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { OptimisticFileCoordinator } from '../FileCoordinator';
import { WorkspaceTools } from '../WorkspaceTools';

describe('OptimisticFileCoordinator', () => {
  let c: OptimisticFileCoordinator;
  beforeEach(() => { c = new OptimisticFileCoordinator(); });

  it('allows creating a brand-new file', () => {
    expect(c.checkWrite('a', '/w/new.ts', null).ok).toBe(true);
  });

  it('allows a write when the file is unchanged since the agent read it', () => {
    c.recordRead('a', '/w/x.ts', 'v1');
    expect(c.checkWrite('a', '/w/x.ts', 'v1').ok).toBe(true);
  });

  it('rejects a blind overwrite of an existing file the agent never read', () => {
    const d = c.checkWrite('a', '/w/x.ts', 'v1');
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/have not read/);
  });

  it('rejects a write when a teammate changed the file since this agent read it', () => {
    c.recordRead('a', '/w/x.ts', 'v1');
    c.recordRead('b', '/w/x.ts', 'v1');
    c.recordWrite('a', '/w/x.ts', 'v2'); // agent A writes a new version

    const d = c.checkWrite('b', '/w/x.ts', 'v2'); // B still thinks it's v1
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/changed since you last read/);

    // After B re-reads the current content, its write is allowed again.
    c.recordRead('b', '/w/x.ts', 'v2');
    expect(c.checkWrite('b', '/w/x.ts', 'v2').ok).toBe(true);
  });

  it('flags a stale dependency: B is told when A changes a file B read but does not write', () => {
    // B reads Y (a dependency it will not write); A edits Y.
    c.recordRead('b', '/w/Y.ts', 'y1');
    c.recordRead('a', '/w/Y.ts', 'y1');
    c.recordWrite('a', '/w/Y.ts', 'y2');

    // B is notified its dependency changed (caught cross-file breakage), once.
    expect(c.takeStaleNotices('b')).toEqual(['/w/Y.ts']);
    expect(c.takeStaleNotices('b')).toEqual([]); // cleared after taking
    // The writer is never stale on its own write.
    expect(c.takeStaleNotices('a')).toEqual([]);
  });

  it('re-reading clears a stale notice', () => {
    c.recordRead('b', '/w/Y.ts', 'y1');
    c.recordRead('a', '/w/Y.ts', 'y1');
    c.recordWrite('a', '/w/Y.ts', 'y2');
    c.recordRead('b', '/w/Y.ts', 'y2'); // B re-reads the fresh version
    expect(c.takeStaleNotices('b')).toEqual([]);
  });
});

describe('WorkspaceTools optimistic concurrency (two agents, shared coordinator)', () => {
  let dir: string;
  let coord: OptimisticFileCoordinator;
  let agentA: WorkspaceTools;
  let agentB: WorkspaceTools;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roam-conc-'));
    await fs.writeFile(path.join(dir, 'shared.ts', ), 'original', 'utf8');
    coord = new OptimisticFileCoordinator();
    const tools = new Set(['read', 'write']);
    agentA = new WorkspaceTools(dir, tools, 'A', coord);
    agentB = new WorkspaceTools(dir, tools, 'B', coord);
  });

  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('lets the second writer through only after re-reading', async () => {
    // Both read the original.
    await agentA.runText('read_file', { path: 'shared.ts' });
    await agentB.runText('read_file', { path: 'shared.ts' });

    // A writes first — succeeds.
    const aWrite = await agentA.runText('write_file', { path: 'shared.ts', content: 'A version' });
    expect(aWrite).toMatch(/Wrote/);

    // B writes based on the stale read — blocked.
    const bBlocked = await agentB.runText('write_file', { path: 'shared.ts', content: 'B version' });
    expect(bBlocked).toMatch(/Write blocked/);
    expect(bBlocked).toMatch(/changed since you last read/);
    // A's content must survive.
    expect(await fs.readFile(path.join(dir, 'shared.ts'), 'utf8')).toBe('A version');

    // B re-reads, reconciles, writes — now allowed.
    await agentB.runText('read_file', { path: 'shared.ts' });
    const bRetry = await agentB.runText('write_file', { path: 'shared.ts', content: 'B reconciled' });
    expect(bRetry).toMatch(/Wrote/);
    expect(await fs.readFile(path.join(dir, 'shared.ts'), 'utf8')).toBe('B reconciled');
  });

  it('blocks writing an existing file without reading it first', async () => {
    const blocked = await agentA.runText('write_file', { path: 'shared.ts', content: 'blind' });
    expect(blocked).toMatch(/have not read/);
  });

  it('allows independent files to be written in parallel without conflict', async () => {
    const a = await agentA.runText('write_file', { path: 'a-only.ts', content: 'A' });
    const b = await agentB.runText('write_file', { path: 'b-only.ts', content: 'B' });
    expect(a).toMatch(/Wrote/);
    expect(b).toMatch(/Wrote/);
  });

  it('warns a dependent agent on its next tool call when a file it read was changed', async () => {
    await agentB.runText('read_file', { path: 'shared.ts' }); // B depends on shared.ts (reads, won't write)
    await agentA.runText('read_file', { path: 'shared.ts' });
    await agentA.runText('write_file', { path: 'shared.ts', content: 'A changed the contract' });

    // B's very next tool action surfaces the cross-file dependency change.
    const next = await agentB.runText('list_dir', { path: '.' });
    expect(next).toMatch(/Dependency changed/);
    expect(next).toMatch(/shared\.ts/);
  });
});
