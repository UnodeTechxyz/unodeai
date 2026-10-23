/*
 * v0.9.97 P2: the host's write, edit, patch and delete tools under the shared write policy, on a real file system
 * and, where the rule is about Git, a real repository. Each test names the rule it realises: review resolution §3
 * (deferred per-target evidence and its six-step order), file effects design §3 (dirty targets, not-yet-created
 * descendants) and handoff §4 (approval, then a per-target lock, then rechecks before the effect).
 */
import { spawnSync } from 'child_process';
import { realpathSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceTools, type WriteApprover } from '../WorkspaceTools';
import { FileWritePolicy, OWN_EFFECT_MAX_AGE_MS, type OverwriteDecisionRequest } from '../fileWritePolicy';
import { gitPathStatus } from '../gitPathStatus';
import { resolveEffectiveRoots } from '../folderAccess';
import type { ResolvedFileGrant } from '../../types';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';

afterEach(removeTemporaryFolders);

const linkKind = process.platform === 'win32' ? 'junction' : 'dir';

async function folder(prefix = 'unode-p2-tools-'): Promise<string> {
  return realpathSync.native(await temporaryFolder(prefix));
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.email=p2@example.invalid', '-c', 'user.name=P2', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}

async function repository(files: Record<string, string>): Promise<string> {
  const root = await folder('unode-p2-repo-');
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return root;
}

/**
 * One host: the real Git probe, editors whose unsaved files the test lists, requests the test starts and ends, a
 * clock it moves, records kept in memory, and the person's decisions answered by `decide`.
 */
function host(options: { decide?: (request: OverwriteDecisionRequest) => Promise<'once' | 'deny'> } = {}) {
  const state = {
    dirty: [] as string[],
    request: 'r1',
    running: new Set<string>(),
    now: 5_000_000,
    stored: undefined as unknown,
    decisions: [] as OverwriteDecisionRequest[],
  };
  const policyHost = {
    workspaceId: () => 'workspace',
    dirtyEditorPaths: () => state.dirty,
    gitPath: gitPathStatus,
    isRequestRunning: (id: string) => state.running.has(id),
    ownEffects: { load: () => state.stored, save: (records: unknown) => { state.stored = records; } },
    now: () => state.now,
  };
  let policy = new FileWritePolicy(policyHost);
  const agent = () => policy.forAgent({
    agentId: 'dev',
    requestId: () => state.request,
    decide: async (request) => {
      state.decisions.push(request);
      return options.decide ? options.decide(request) : 'once';
    },
  });
  return {
    state,
    agent,
    /** A new extension host on the same workspace storage: records stay, what requests read is gone. */
    restart: () => { policy = new FileWritePolicy(policyHost); },
  };
}

function toolsFor(root: string, h: ReturnType<typeof host>, options: {
  ask?: boolean;
  approve?: WriteApprover;
  trusted?: () => boolean;
  fileGrants?: { read: ResolvedFileGrant[]; write: ResolvedFileGrant[] };
} = {}): WorkspaceTools {
  const tools = new WorkspaceTools(
    root, new Set(['read', 'write']), 'dev',
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    () => options.ask ?? false, options.approve,
    undefined, undefined, undefined, [], options.trusted ?? (() => true),
    undefined, undefined, undefined, undefined, undefined, undefined, options.fileGrants,
  );
  tools.setFileWrites(h.agent());
  return tools;
}

describe('host write tools: Git, non-Git and unsaved editors (review resolution §3)', () => {
  it('rule 4: a tracked file Git shows unchanged is written without a question', async () => {
    const root = await repository({ 'src/a.ts': 'export const a = 1;\n' });
    const h = host();
    const tools = toolsFor(root, h);
    expect(await tools.run('write_file', { path: 'src/a.ts', content: 'export const a = 2;\n' })).toMatchObject({ status: 'success' });
    expect(h.state.decisions).toEqual([]);
    expect(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
  });

  it('rule 3: uncommitted work in Git needs one decision; a denial leaves it, and the same request then writes freely', async () => {
    const root = await repository({ 'notes.md': 'committed\n' });
    await fs.writeFile(path.join(root, 'notes.md'), 'the person\'s uncommitted edit\n');
    let answer: 'once' | 'deny' = 'deny';
    const h = host({ decide: async () => answer });
    const tools = toolsFor(root, h);
    const denied = await tools.run('apply_edit', { path: 'notes.md', old_string: 'edit', new_string: 'EDIT' });
    expect(denied).toMatchObject({ status: 'refused', reason: 'consent' });
    expect(denied.output).toMatch(/did not approve this change to the file as it is now/);
    expect(await fs.readFile(path.join(root, 'notes.md'), 'utf8')).toBe('the person\'s uncommitted edit\n');
    expect(h.state.decisions).toHaveLength(1);
    expect(h.state.decisions[0]).toMatchObject({ path: 'notes.md', operation: 'write' });
    expect(h.state.decisions[0].reason).toMatch(/changes that are not committed to Git.*covers this one change to the file as it is now/s);

    answer = 'once';
    expect(await tools.run('apply_edit', { path: 'notes.md', old_string: 'edit', new_string: 'EDIT' })).toMatchObject({ status: 'success' });
    expect(await tools.run('apply_edit', { path: 'notes.md', old_string: 'EDIT', new_string: 'edit, twice' })).toMatchObject({ status: 'success' });
    expect(h.state.decisions).toHaveLength(2);
  });

  it('rule 3: an untracked file needs a decision, and nobody to ask is a refusal', async () => {
    const root = await repository({ 'a.txt': 'a\n' });
    await fs.writeFile(path.join(root, 'draft.txt'), 'untracked draft\n');
    const h = host({ decide: async () => 'deny' });
    await toolsFor(root, h).run('write_file', { path: 'draft.txt', content: 'replaced' });
    expect(h.state.decisions[0].reason).toMatch(/never been committed to Git/);
    const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'dev');
    tools.setFileWrites(new FileWritePolicy({ workspaceId: () => 'w', gitPath: gitPathStatus }).forAgent({ agentId: 'dev' }));
    const refused = await tools.run('write_file', { path: 'draft.txt', content: 'replaced' });
    expect(refused).toMatchObject({ status: 'refused', reason: 'consent' });
    expect(refused.output).toMatch(/nobody can be asked here/);
    expect(await fs.readFile(path.join(root, 'draft.txt'), 'utf8')).toBe('untracked draft\n');
  });

  it('rule 5: outside Git, a file this request read is written without a question, and one it did not read asks once', async () => {
    const root = await folder();
    await fs.writeFile(path.join(root, 'read.txt'), 'read first\n');
    await fs.writeFile(path.join(root, 'unread.txt'), 'never read\n');
    const h = host();
    const tools = toolsFor(root, h);
    expect(await tools.run('read_file', { path: 'read.txt' })).toMatchObject({ status: 'success' });
    expect(await tools.run('write_file', { path: 'read.txt', content: 'changed' })).toMatchObject({ status: 'success' });
    expect(h.state.decisions).toEqual([]);
    expect(await tools.run('write_file', { path: 'unread.txt', content: 'changed' })).toMatchObject({ status: 'success' });
    expect(h.state.decisions.map((decision) => decision.path)).toEqual(['unread.txt']);
  });

  it('rule 1: a file with unsaved editor changes is refused, never saved, and nobody is asked', async () => {
    const root = await repository({ 'a.txt': 'on disk\n' });
    const h = host();
    h.state.dirty = [path.join(root, 'a.txt')];
    const tools = toolsFor(root, h, { ask: true, approve: async () => 'once' });
    const result = await tools.run('write_file', { path: 'a.txt', content: 'agent' });
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.output).toMatch(/unsaved changes in an editor.*does not save them/s);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('on disk\n');
    expect(await tools.run('delete_file', { path: 'a.txt' })).toMatchObject({ status: 'failed' });
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('on disk\n');
    expect(h.state.decisions).toEqual([]);
  });
});

describe('own effects across requests (review resolution §3)', () => {
  it('a later request continues a file an earlier one wrote, until it expires or someone else changes it', async () => {
    const root = await repository({ 'a.txt': 'a\n' });
    const h = host();
    const tools = toolsFor(root, h);
    // r1 creates an untracked file: a new file asks nothing.
    expect(await tools.run('write_file', { path: 'made.txt', content: 'r1' })).toMatchObject({ status: 'success' });
    h.state.request = 'r2';
    expect(await tools.run('write_file', { path: 'made.txt', content: 'r2' })).toMatchObject({ status: 'success' });
    expect(h.state.decisions).toEqual([]);

    // Someone else's change in between: the record no longer matches, so r3 asks.
    await fs.writeFile(path.join(root, 'made.txt'), 'the person');
    h.state.request = 'r3';
    expect(await tools.run('write_file', { path: 'made.txt', content: 'r3' })).toMatchObject({ status: 'success' });
    expect(h.state.decisions).toHaveLength(1);

    // r3's record expires after 30 days.
    h.state.now += OWN_EFFECT_MAX_AGE_MS + 1;
    h.state.request = 'r4';
    expect(await tools.run('write_file', { path: 'made.txt', content: 'r4' })).toMatchObject({ status: 'success' });
    expect(h.state.decisions).toHaveLength(2);
  });

  it('a record of a request that is still running is concurrent work, not permission', async () => {
    const root = await repository({ 'a.txt': 'a\n' });
    const h = host();
    const tools = toolsFor(root, h);
    h.state.running.add('r1');
    expect(await tools.run('write_file', { path: 'made.txt', content: 'r1' })).toMatchObject({ status: 'success' });
    h.state.request = 'r2';
    await tools.run('write_file', { path: 'made.txt', content: 'r2' });
    expect(h.state.decisions.map((decision) => decision.reason)).toEqual([expect.stringMatching(/another request that is still running/)]);
  });

  it('records survive a restart of the host; what a request read does not', async () => {
    const root = await folder();
    await fs.writeFile(path.join(root, 'read.txt'), 'x');
    const h = host();
    let tools = toolsFor(root, h);
    expect(await tools.run('write_file', { path: 'made.txt', content: 'before restart' })).toMatchObject({ status: 'success' });
    await tools.run('read_file', { path: 'read.txt' });
    h.restart();
    tools = toolsFor(root, h);
    h.state.request = 'r2';
    expect(await tools.run('write_file', { path: 'made.txt', content: 'after restart' })).toMatchObject({ status: 'success' });
    expect(h.state.decisions).toEqual([]);
    h.state.request = 'r1';
    expect(await tools.run('write_file', { path: 'read.txt', content: 'y' })).toMatchObject({ status: 'success' });
    expect(h.state.decisions.map((decision) => decision.path)).toEqual(['read.txt']);
  });
});

describe('waits, rechecks and the per-target lock (handoff §4)', () => {
  it('a decision is void when the file changes while it is open', async () => {
    const root = await folder();
    const target = path.join(root, 'a.txt');
    await fs.writeFile(target, 'original');
    const h = host({ decide: async () => { await fs.writeFile(target, 'changed while asked'); return 'once'; } });
    const tools = toolsFor(root, h);
    const result = await tools.run('write_file', { path: 'a.txt', content: 'agent' });
    expect(result.output).toMatch(/changed while this change waited/);
    expect(await fs.readFile(target, 'utf8')).toBe('changed while asked');
  });

  it('an ordinary approval is held to the file it was given for', async () => {
    const root = await repository({ 'a.txt': 'committed\n' });
    const target = path.join(root, 'a.txt');
    const h = host();
    const tools = toolsFor(root, h, { ask: true, approve: async () => { await fs.writeFile(target, 'edited during approval\n'); return 'once'; } });
    expect((await tools.run('write_file', { path: 'a.txt', content: 'agent\n' })).output).toMatch(/changed while this change waited/);
    expect(await fs.readFile(target, 'utf8')).toBe('edited during approval\n');
  });

  it('trust lost, the agent stopped, the call stopped, or an editor opened unsaved during the wait: no effect', async () => {
    const root = await repository({ 'a.txt': 'committed\n' });
    const target = path.join(root, 'a.txt');
    let trusted = true;
    const h = host();
    const abort = new AbortController();
    const cases: Array<[string, (tools: WorkspaceTools) => void, RegExp, { signal?: AbortSignal }]> = [
      ['trust', () => { trusted = false; }, /no longer trusted/, {}],
      ['dirty', () => { h.state.dirty = [target]; }, /unsaved changes in an editor/, {}],
      ['call', () => { abort.abort(); }, /request was stopped/, { signal: abort.signal }],
      // The host's own shutdown, through the surface's test seam for it.
      ['shutdown', (tools) => { (tools as unknown as { backgroundShutdown: { started: boolean } }).backgroundShutdown = { started: true }; }, /agent is stopping/, {}],
      ['agent', (tools) => { tools.retire(); }, /agent is stopping/, {}],
    ];
    for (const [name, change, message, options] of cases) {
      trusted = true;
      h.state.dirty = [];
      // A surface of its own for each case, so no case's stop carries into the next.
      const tools: WorkspaceTools = toolsFor(root, h, { ask: true, trusted: () => trusted, approve: async () => { change(tools); return 'once'; } });
      const result = await tools.run('write_file', { path: 'a.txt', content: `agent ${name}\n` }, options);
      expect(result.output, name).toMatch(message);
      expect(await fs.readFile(target, 'utf8'), name).toBe('committed\n');
    }
  });

  it('runs two changes to one file one after the other, and the second, planned for no file, finds one and stops', async () => {
    const root = await folder();
    const h = host();
    const tools = toolsFor(root, h);
    const other = toolsFor(root, h);
    const [first, second] = await Promise.all([
      tools.run('write_file', { path: 'a.txt', content: 'first' }),
      other.run('write_file', { path: 'a.txt', content: 'second' }),
    ]);
    // Review resolution §3 rule 6: a file that appears while a new-file plan waits ends that plan. Which of the two
    // reaches the lock first is not fixed; exactly one writes, and the other stops.
    const results = [{ result: first, content: 'first', tools }, { result: second, content: 'second', tools: other }];
    const won = results.filter((entry) => entry.result.status === 'success');
    const lost = results.filter((entry) => entry.result.status !== 'success');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].result.output).toMatch(/appeared while this change waited/);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe(won[0].content);
    // Planned again, it finds this request's own last write there and goes on.
    expect(await lost[0].tools.run('write_file', { path: 'a.txt', content: lost[0].content })).toMatchObject({ status: 'success' });
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe(lost[0].content);
    expect(h.state.decisions).toEqual([]);
  });
});

describe('not-yet-created descendants (file effects design §3)', () => {
  it('creates missing folders as part of the write, names them, and creates nothing when the write is refused', async () => {
    const root = await folder();
    const h = host();
    const tools = toolsFor(root, h, { ask: true, approve: async () => 'deny' });
    expect(await tools.run('write_file', { path: 'a/b/c.txt', content: 'x' })).toMatchObject({ status: 'refused' });
    expect(await fs.readdir(root)).toEqual([]);

    const allowed = toolsFor(root, h);
    const result = await allowed.run('write_file', { path: 'a/b/c.txt', content: 'x' });
    expect(result).toMatchObject({ status: 'success' });
    expect(result.output).toContain('Created folders a, a/b.');
  });

  it('refuses when a missing folder on the way becomes a link out while the approval is open', async () => {
    const root = await folder();
    const outside = await folder('unode-p2-outside-');
    const h = host();
    const tools = toolsFor(root, h, {
      ask: true,
      approve: async () => { await fs.symlink(outside, path.join(root, 'a'), linkKind); return 'once'; },
    });
    const result = await tools.run('write_file', { path: 'a/b/c.txt', content: 'x' });
    expect(result.status).not.toBe('success');
    expect(result.output).toMatch(/escapes configured workspace/);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('writes an exact-file grant outside every writable folder in place, leaving nothing beside it', async () => {
    const root = await folder();
    const elsewhere = await folder('unode-p2-grant-');
    const granted = path.join(elsewhere, 'notes.md');
    await fs.writeFile(granted, 'granted file\n');
    const resolved = resolveEffectiveRoots({
      grants: [{ path: granted, permission: 'readwrite' }],
      fallbackPrimaryRoot: root, fallbackReadRoots: [], workspaceRoots: [root], isTrusted: true,
    });
    const h = host();
    const tools = toolsFor(root, h, { fileGrants: { read: resolved.readFiles, write: resolved.writeFiles } });
    await tools.run('read_file', { path: granted });
    expect(await tools.run('write_file', { path: granted, content: 'changed\n' })).toMatchObject({ status: 'success' });
    expect(await fs.readFile(granted, 'utf8')).toBe('changed\n');
    expect(await fs.readdir(elsewhere)).toEqual(['notes.md']);
  });
});

describe('deletes under the same policy', () => {
  it('a file nobody vouches for needs a decision before delete_file; one this request read does not', async () => {
    const root = await folder();
    await fs.writeFile(path.join(root, 'unread.txt'), 'u');
    await fs.writeFile(path.join(root, 'read.txt'), 'r');
    const h = host({ decide: async () => 'deny' });
    const tools = toolsFor(root, h);
    expect(await tools.run('delete_file', { path: 'unread.txt' })).toMatchObject({ status: 'refused', reason: 'consent' });
    expect(await fs.readFile(path.join(root, 'unread.txt'), 'utf8')).toBe('u');
    await tools.run('read_file', { path: 'read.txt' });
    expect(await tools.run('delete_file', { path: 'read.txt' })).toMatchObject({ status: 'success' });
    expect(h.state.decisions.map((decision) => decision.operation)).toEqual(['delete']);
  });

  it('P2-N1: delete_file refuses a symbolic link; the link and its target stay and nothing is recorded', async () => {
    const root = await folder();
    const h = host();
    const tools = toolsFor(root, h);
    const link = path.join(root, 'link');
    // A file symlink to a regular file on POSIX (Codex's exact case); a junction on Windows, where a file symlink
    // needs privilege. Both are reported by lstat as a symbolic link, and the delete must refuse either.
    let readTarget: () => Promise<string>;
    if (process.platform === 'win32') {
      const dir = path.join(root, 'realdir');
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, 'keep.txt'), 'referent bytes');
      await fs.symlink(dir, link, 'junction');
      readTarget = () => fs.readFile(path.join(dir, 'keep.txt'), 'utf8');
    } else {
      const file = path.join(root, 'real.txt');
      await fs.writeFile(file, 'referent bytes');
      await fs.symlink(file, link, 'file');
      readTarget = () => fs.readFile(file, 'utf8');
    }
    const result = await tools.run('delete_file', { path: 'link' });
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.output).toMatch(/symbolic link/);
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true); // the link object was not removed
    expect(await readTarget()).toBe('referent bytes'); // its referent was not touched or recorded as gone
    expect(h.state.decisions).toEqual([]); // refused before any referent evidence/decision was taken
  });

  it('delete_dir asks for a folder holding someone else\'s files, names them, and removes the request\'s own folder freely', async () => {
    const root = await folder();
    await fs.mkdir(path.join(root, 'theirs'));
    await fs.writeFile(path.join(root, 'theirs', 'keep.txt'), 'k');
    const h = host({ decide: async () => 'deny' });
    const tools = toolsFor(root, h);
    const refused = await tools.run('delete_dir', { path: 'theirs' });
    expect(refused).toMatchObject({ status: 'refused', reason: 'consent' });
    expect(h.state.decisions[0].reason).toContain('"keep.txt"');
    expect(await fs.readFile(path.join(root, 'theirs', 'keep.txt'), 'utf8')).toBe('k');

    await tools.run('write_file', { path: 'tmp/one.txt', content: '1' });
    await tools.run('write_file', { path: 'tmp/two/two.txt', content: '2' });
    expect(await tools.run('delete_dir', { path: 'tmp' })).toMatchObject({ status: 'success' });
    expect(h.state.decisions).toHaveLength(1);
  });

  it('delete_dir refuses a folder holding a file with unsaved editor changes, and one whose content changed during the wait', async () => {
    const root = await folder();
    const h = host();
    const tools = toolsFor(root, h);
    await tools.run('write_file', { path: 'tmp/a.txt', content: 'a' });
    h.state.dirty = [path.join(root, 'tmp', 'a.txt')];
    expect((await tools.run('delete_dir', { path: 'tmp' })).output).toMatch(/unsaved changes in an editor/);
    h.state.dirty = [];

    const asking = toolsFor(root, h, { ask: true, approve: async () => { await fs.writeFile(path.join(root, 'tmp', 'late.txt'), 'late'); return 'once'; } });
    expect((await asking.run('delete_dir', { path: 'tmp' })).output).toMatch(/changed while this delete waited/);
    expect(await fs.readFile(path.join(root, 'tmp', 'late.txt'), 'utf8')).toBe('late');
  });
});

describe('a file with more than one name (review resolution §10.4)', () => {
  it('is not replaced, and one of its names may still be deleted', async () => {
    const root = await folder();
    const outside = await folder('unode-p2-outside-');
    await fs.writeFile(path.join(outside, 'real.txt'), 'outside');
    await fs.link(path.join(outside, 'real.txt'), path.join(root, 'alias.txt'));
    const h = host();
    const tools = toolsFor(root, h);
    await tools.run('read_file', { path: 'alias.txt' });
    const result = await tools.run('write_file', { path: 'alias.txt', content: 'changed' });
    expect(result.output).toMatch(/more than one name on disk/);
    expect(await fs.readFile(path.join(outside, 'real.txt'), 'utf8')).toBe('outside');
    expect(await tools.run('delete_file', { path: 'alias.txt' })).toMatchObject({ status: 'success' });
    expect(await fs.readFile(path.join(outside, 'real.txt'), 'utf8')).toBe('outside');
  });
});
