/*
 * v0.9.97 P2: the shared write policy on its own. Each test names the rule it realises: review resolution §3 (the
 * six-step order, own-effect records), file effects design §3 (dirty targets, not-yet-created descendants) and
 * §10.4 (hard links). The routes' wiring is tested beside each route.
 */
import { spawnSync } from 'child_process';
import { realpathSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitFileBytes,
  FileWritePolicy,
  type AgentFileWrites,
  type FileWritePolicyHost,
  OWN_EFFECT_MAX_AGE_MS,
  OWN_EFFECT_MAX_ENTRIES,
  type OwnEffectRecord,
  prepareNativeFileChanges,
  readTargetState,
  sameTargetState,
  TARGET_STATE_HASH_MAX_BYTES,
  type TargetState,
} from '../fileWritePolicy';
import { gitPathStatus, parsePorcelainZ, type GitPathReport } from '../gitPathStatus';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';

afterEach(removeTemporaryFolders);

async function folder(): Promise<string> {
  return realpathSync.native(await temporaryFolder('unode-p2-policy-'));
}

/** A host whose every source is counted, with Git answered from a map and a clock the test moves. */
function countedHost(overrides: Partial<FileWritePolicyHost> & { git?: Map<string, GitPathReport>; dirty?: string[]; running?: Set<string> } = {}) {
  const counts = { git: 0, dirty: 0, load: 0, save: 0 };
  const stored: { value: unknown } = { value: undefined };
  let now = 1_000_000;
  const host: FileWritePolicyHost = {
    workspaceId: () => 'workspace-1',
    dirtyEditorPaths: () => { counts.dirty++; return overrides.dirty ?? []; },
    gitPath: async (target) => { counts.git++; return overrides.git?.get(target) ?? { repository: false }; },
    isRequestRunning: (id) => overrides.running?.has(id) ?? false,
    ownEffects: {
      load: () => { counts.load++; return stored.value; },
      save: (records) => { counts.save++; stored.value = JSON.parse(JSON.stringify(records)); },
    },
    now: () => now,
    ...overrides,
  };
  return { host, counts, stored, advance: (ms: number) => { now += ms; } };
}

async function fileAt(root: string, name: string, content: string): Promise<string> {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

async function stateOf(file: string) {
  return (await readTargetState(file)).state;
}

/** A host write read back as written, for the request the agent acts for now (the P2 own-effect record). */
function ownWrite(writes: AgentFileWrites, file: string, state: TargetState): void {
  writes.noteEffect(file, state, 'host-verified', writes.attribution(), true);
}

const changed: GitPathReport = { repository: true, entries: [{ path: 'x', folder: false, state: 'changed' }] };
const untracked: GitPathReport = { repository: true, entries: [{ path: 'x', folder: false, state: 'untracked' }] };
const clean: GitPathReport = { repository: true, entries: [] };

describe('the shared write policy: the six-step order (review resolution §3)', () => {
  it('rule 1: refuses a target with unsaved editor changes, even when its bytes on disk are unchanged', async () => {
    const root = await folder();
    const file = await fileAt(root, 'a.txt', 'same');
    const { host } = countedHost({ dirty: [file], git: new Map([[file, clean]]) });
    const writes = new FileWritePolicy(host).forAgent({ agentId: 'a', requestId: () => 'r1' });
    const verdict = await writes.evaluate(file, await stateOf(file), 'a.txt');
    expect(verdict).toMatchObject({ verdict: 'refuse', code: 'dirty-buffer' });
    expect(verdict.verdict === 'refuse' && verdict.reason).toMatch(/unsaved changes in an editor.*does not save them/);
    // A file that is not there yet, open unsaved in an editor, is refused too: writing it would race the buffer.
    const missing = path.join(root, 'new.txt');
    const { host: newHost } = countedHost({ dirty: [missing] });
    expect(await new FileWritePolicy(newHost).forAgent({ agentId: 'a' }).evaluate(missing, { exists: false }, 'new.txt'))
      .toMatchObject({ verdict: 'refuse', code: 'dirty-buffer' });
  });

  it('rule 2: a file changed after this request read it needs a decision, whatever Git says', async () => {
    const root = await folder();
    const file = await fileAt(root, 'a.txt', 'read');
    const { host } = countedHost({ git: new Map([[file, clean]]) });
    const writes = new FileWritePolicy(host).forAgent({ agentId: 'a', requestId: () => 'r1' });
    writes.noteRead(file, await stateOf(file));
    await fs.writeFile(file, 'someone else');
    expect(await writes.evaluate(file, await stateOf(file), 'a.txt')).toMatchObject({ verdict: 'decide', code: 'changed-since-read' });
  });

  it('rule 3: uncommitted or untracked work in Git needs a decision when the host has no record of making it', async () => {
    const root = await folder();
    const file = await fileAt(root, 'a.txt', 'user work');
    for (const report of [changed, untracked]) {
      const { host } = countedHost({ git: new Map([[file, report]]) });
      const writes = new FileWritePolicy(host).forAgent({ agentId: 'a', requestId: () => 'r1' });
      // Even after this request read it: a read is not a record that the work is UnodeAi's.
      writes.noteRead(file, await stateOf(file));
      expect(await writes.evaluate(file, await stateOf(file), 'a.txt')).toMatchObject({ verdict: 'decide', code: 'git-uncommitted' });
    }
  });

  it('rule 3, the exception: an earlier request\'s own effect lets the next request go on while bytes and identity match', async () => {
    const root = await folder();
    const file = await fileAt(root, 'a.txt', 'written by r1');
    const { host } = countedHost({ git: new Map([[file, untracked]]) });
    const policy = new FileWritePolicy(host);
    let request = 'r1';
    const writes = policy.forAgent({ agentId: 'a', requestId: () => request });
    ownWrite(writes, file, await stateOf(file));
    request = 'r2';
    expect(await writes.evaluate(file, await stateOf(file), 'a.txt')).toEqual({ verdict: 'proceed', basis: 'own-effect' });
    // Invalidated by a change of bytes, even one of the same length: back to a decision, never a wider permission.
    await fs.writeFile(file, 'WRITTEN BY R1');
    expect(await writes.evaluate(file, await stateOf(file), 'a.txt')).toMatchObject({ verdict: 'decide', code: 'git-uncommitted' });
    await fs.writeFile(file, 'edited by the person');
    expect(await writes.evaluate(file, await stateOf(file), 'a.txt')).toMatchObject({ verdict: 'decide', code: 'git-uncommitted' });
  });

  it('rule 3: an own-effect record is bound to the file\'s identity, not only its bytes', async () => {
    const root = await folder();
    const file = await fileAt(root, 'a.txt', 'same bytes');
    const { host } = countedHost({ git: new Map([[file, untracked]]) });
    let request = 'r1';
    const writes = new FileWritePolicy(host).forAgent({ agentId: 'a', requestId: () => request });
    ownWrite(writes, file, await stateOf(file));
    // The same bytes in a file put in its place (another program's save through a rename) are not UnodeAi's.
    const replacement = await fileAt(root, 'other.txt', 'same bytes');
    await fs.rm(file);
    await fs.rename(replacement, file);
    request = 'r2';
    expect(await writes.evaluate(file, await stateOf(file), 'a.txt')).toMatchObject({ verdict: 'decide', code: 'git-uncommitted' });
  });

  it('rule 3: an own-effect record stops counting after 30 days', async () => {
    const root = await folder();
    const file = await fileAt(root, 'a.txt', 'written by r1');
    const { host, advance } = countedHost({ git: new Map([[file, changed]]) });
    let request = 'r1';
    const writes = new FileWritePolicy(host).forAgent({ agentId: 'a', requestId: () => request });
    ownWrite(writes, file, await stateOf(file));
    request = 'r2';
    advance(OWN_EFFECT_MAX_AGE_MS);
    expect(await writes.evaluate(file, await stateOf(file), 'a.txt')).toEqual({ verdict: 'proceed', basis: 'own-effect' });
    request = 'r3';
    advance(1);
    expect(await writes.evaluate(file, await stateOf(file), 'a.txt')).toMatchObject({ verdict: 'decide', code: 'git-uncommitted' });
  });

  it('rule 2: work of another request that is still running is concurrent, and its record vouches for nothing here', async () => {
    const root = await folder();
    const file = await fileAt(root, 'a.txt', 'written by r1');
    const running = new Set(['r1']);
    const { host } = countedHost({ git: new Map([[file, changed]]), running });
    const policy = new FileWritePolicy(host);
    ownWrite(policy.forAgent({ agentId: 'pm', requestId: () => 'r1' }), file, await stateOf(file));
    const other = policy.forAgent({ agentId: 'dev', requestId: () => 'r2' });
    expect(await other.evaluate(file, await stateOf(file), 'a.txt')).toMatchObject({ verdict: 'decide', code: 'concurrent-request' });
    running.delete('r1');
    expect(await other.evaluate(file, await stateOf(file), 'a.txt')).toEqual({ verdict: 'proceed', basis: 'own-effect' });
  });

  it('rule 2: a stored record of a running request is concurrent too, with nothing of it seen in this host', async () => {
    const root = await folder();
    const file = await fileAt(root, 'a.txt', 'written by r1');
    const first = countedHost({ git: new Map([[file, changed]]) });
    ownWrite(new FileWritePolicy(first.host).forAgent({ agentId: 'pm', requestId: () => 'r1' }), file, await stateOf(file));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = countedHost({ git: new Map([[file, changed]]), running: new Set(['r1']) });
    second.stored.value = first.stored.value;
    expect(await new FileWritePolicy(second.host).forAgent({ agentId: 'dev', requestId: () => 'r2' }).evaluate(file, await stateOf(file), 'a.txt'))
      .toMatchObject({ verdict: 'decide', code: 'concurrent-request' });
  });

  it('rule 2: a write this host saw from a running request stays concurrent after its record has expired', async () => {
    const root = await folder();
    const file = await fileAt(root, 'a.txt', 'written by r1');
    const { host, advance } = countedHost({ git: new Map([[file, changed]]), running: new Set(['r1']) });
    const policy = new FileWritePolicy(host);
    ownWrite(policy.forAgent({ agentId: 'pm', requestId: () => 'r1' }), file, await stateOf(file));
    advance(OWN_EFFECT_MAX_AGE_MS + 1);
    expect(await policy.forAgent({ agentId: 'dev', requestId: () => 'r2' }).evaluate(file, await stateOf(file), 'a.txt'))
      .toMatchObject({ verdict: 'decide', code: 'concurrent-request' });
  });

  it('rule 4: a tracked file Git shows unchanged goes on under the caller\'s permissions', async () => {
    const root = await folder();
    const file = await fileAt(root, 'a.txt', 'committed');
    const { host } = countedHost({ git: new Map([[file, clean]]) });
    expect(await new FileWritePolicy(host).forAgent({ agentId: 'a' }).evaluate(file, await stateOf(file), 'a.txt'))
      .toEqual({ verdict: 'proceed', basis: 'git-clean' });
  });

  it('rule 5: outside Git (or ignored by it), a read of this request or an own record lets it go on; neither asks once', async () => {
    const root = await folder();
    const file = await fileAt(root, 'a.txt', 'plain');
    const ignored: GitPathReport = { repository: true, entries: [{ path: root, folder: true, state: 'ignored' }] };
    for (const report of [{ repository: false } as GitPathReport, ignored, { repository: 'unknown', reason: 'no git' } as GitPathReport]) {
      const { host } = countedHost({ git: new Map([[file, report]]) });
      const policy = new FileWritePolicy(host);
      const writes = policy.forAgent({ agentId: 'a', requestId: () => 'r1' });
      expect(await writes.evaluate(file, await stateOf(file), 'a.txt')).toMatchObject({ verdict: 'decide', code: 'no-evidence' });
      writes.noteRead(file, await stateOf(file));
      expect(await writes.evaluate(file, await stateOf(file), 'a.txt')).toEqual({ verdict: 'proceed', basis: 'read-snapshot' });
      // A read of another request is not this request's evidence.
      expect(await policy.forAgent({ agentId: 'a', requestId: () => 'r9' }).evaluate(file, await stateOf(file), 'a.txt'))
        .toMatchObject({ verdict: 'decide', code: 'no-evidence' });
    }
  });

  it('rule 6: a file that is not there goes on, and asks nothing of Git', async () => {
    const root = await folder();
    const { host, counts } = countedHost();
    const target = path.join(root, 'deep', 'new.txt');
    expect(await new FileWritePolicy(host).forAgent({ agentId: 'a' }).evaluate(target, { exists: false }, 'deep/new.txt'))
      .toEqual({ verdict: 'proceed', basis: 'new-file' });
    expect(counts.git).toBe(0);
  });

  it('a later write of the same request uses its own last state, and a change after it is foreign', async () => {
    const root = await folder();
    const file = await fileAt(root, 'a.txt', 'v1');
    const { host } = countedHost({ git: new Map([[file, changed]]) });
    const writes = new FileWritePolicy(host).forAgent({ agentId: 'a', requestId: () => 'r1' });
    ownWrite(writes, file, await stateOf(file));
    expect(await writes.evaluate(file, await stateOf(file), 'a.txt')).toEqual({ verdict: 'proceed', basis: 'own-latest' });
    await fs.writeFile(file, 'someone else');
    expect(await writes.evaluate(file, await stateOf(file), 'a.txt')).toMatchObject({ verdict: 'decide', code: 'changed-since-own-write' });
  });

  it('refuses to replace a file with more than one name on disk, and lets one name of it be deleted (§10.4)', async () => {
    const root = await folder();
    const file = await fileAt(root, 'a.txt', 'shared');
    await fs.link(file, path.join(root, 'b.txt'));
    const { host } = countedHost({ git: new Map([[file, clean]]) });
    const writes = new FileWritePolicy(host).forAgent({ agentId: 'a' });
    const state = await stateOf(file);
    expect(state.nlink).toBe(2);
    expect(await writes.evaluate(file, state, 'a.txt', 'write')).toMatchObject({ verdict: 'refuse', code: 'hard-link' });
    expect(await writes.evaluate(file, state, 'a.txt', 'delete')).toEqual({ verdict: 'proceed', basis: 'git-clean' });
  });

  it('the unhosted policy has no evidence to weigh, and still refuses hard links and non-files', async () => {
    const root = await folder();
    const file = await fileAt(root, 'a.txt', 'x');
    const writes = FileWritePolicy.unhosted().forAgent({ agentId: 'a' });
    expect(await writes.evaluate(file, await stateOf(file), 'a.txt')).toEqual({ verdict: 'proceed', basis: 'unhosted' });
    expect(await writes.evaluate(root, await stateOf(root), '.')).toMatchObject({ verdict: 'refuse', code: 'not-a-file' });
    expect(await writes.decide({ path: 'a.txt', reason: 'r', operation: 'write', before: null, after: '' })).toBe('unavailable');
  });

  // INT-P2P3 finding F1: such a file used to get the decision card, and a yes then always failed the look after the
  // wait, which told the model the file had changed. USAGE "Restoring a file": a file over 32 MiB is not replaced.
  it('refuses to replace or delete a file larger than 32 MiB before any evidence or decision, on every route', async () => {
    const root = await folder();
    const file = await fileAt(root, 'huge.bin', 'stand-in');
    // What the look reports for a file above the hashing bound: its identity and size, and no SHA-256.
    const huge = { ...(await stateOf(file)), size: TARGET_STATE_HASH_MAX_BYTES + 1, sha256: undefined };
    const asked: string[] = [];
    const { host, counts } = countedHost({ git: new Map([[file, untracked]]), readState: async () => ({ state: huge }) });
    const writes = new FileWritePolicy(host).forAgent({
      agentId: 'a',
      requestId: () => 'r1',
      decide: async (request) => { asked.push(request.path); return 'once'; },
    });
    for (const operation of ['write', 'delete'] as const) {
      const verdict = await writes.evaluate(file, huge, 'huge.bin', operation);
      expect(verdict).toMatchObject({ verdict: 'refuse', code: 'too-large' });
      expect(verdict.verdict === 'refuse' && verdict.reason)
        .toMatch(/"huge\.bin" is larger than 32 MiB: UnodeAi cannot keep a restore point of a file this large.*Nothing was changed/);
    }
    // Without a host too: no look after a wait could find such a file unchanged.
    expect(await FileWritePolicy.unhosted().forAgent({ agentId: 'a' }).evaluate(file, huge, 'huge.bin'))
      .toMatchObject({ verdict: 'refuse', code: 'too-large' });
    // A native Write or Edit (Claude's PreToolUse, Codex's file-change approval) is refused with the same reason.
    const native = await prepareNativeFileChanges(writes, [root], root, [{ path: 'huge.bin', operation: 'update', after: Buffer.from('x') }]);
    expect(native.ok).toBe(false);
    expect(!native.ok && native.reason).toMatch(/"huge\.bin" is larger than 32 MiB/);
    expect(asked).toEqual([]);
    expect(counts.git).toBe(0);
  });
});

describe('own-effect records: metadata only, bounded, kept across a restart (review resolution §3)', () => {
  it('survives a new policy on the same storage, holds no content, and ignores another workspace or rule revision', async () => {
    const root = await folder();
    const file = await fileAt(root, 'a.txt', 'secret-free bytes');
    const first = countedHost({ git: new Map([[file, changed]]) });
    ownWrite(new FileWritePolicy(first.host).forAgent({ agentId: 'a', requestId: () => 'r1' }), file, await stateOf(file));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const records = first.stored.value as OwnEffectRecord[];
    expect(records).toHaveLength(1);
    expect(Object.keys(records[0]).sort()).toEqual(['at', 'dev', 'evidence', 'ino', 'requestId', 'revision', 'sha256', 'size', 'target', 'workspace']);
    expect(JSON.stringify(records)).not.toContain('secret-free bytes');

    // A restart: a new policy, the same workspace storage.
    const restarted = countedHost({ git: new Map([[file, changed]]) });
    restarted.stored.value = records;
    expect(await new FileWritePolicy(restarted.host).forAgent({ agentId: 'a', requestId: () => 'r2' }).evaluate(file, await stateOf(file), 'a.txt'))
      .toEqual({ verdict: 'proceed', basis: 'own-effect' });

    for (const foreign of [{ ...records[0], workspace: 'workspace-2' }, { ...records[0], revision: 0 }, { ...records[0], sha256: 'not-a-hash' }]) {
      const other = countedHost({ git: new Map([[file, changed]]) });
      other.stored.value = [foreign];
      expect(await new FileWritePolicy(other.host).forAgent({ agentId: 'a', requestId: () => 'r2' }).evaluate(file, await stateOf(file), 'a.txt'))
        .toMatchObject({ verdict: 'decide' });
    }
  });

  it('keeps at most 1,000 records per workspace, dropping the oldest', async () => {
    const root = await folder();
    const { host, stored } = countedHost();
    const writes = new FileWritePolicy(host).forAgent({ agentId: 'a', requestId: () => 'r1' });
    const state = { exists: true, kind: 'file' as const, size: 1, sha256: 'a'.repeat(64), dev: '1', ino: '1', nlink: 1 };
    for (let index = 0; index <= OWN_EFFECT_MAX_ENTRIES; index++) ownWrite(writes, path.join(root, `f${index}.txt`), state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const records = stored.value as OwnEffectRecord[];
    expect(records).toHaveLength(OWN_EFFECT_MAX_ENTRIES);
    expect(records.some((record) => record.target.endsWith(`${path.sep}f0.txt`))).toBe(false);
  });

  it('a removed or uncertain target loses its record', async () => {
    const root = await folder();
    const file = await fileAt(root, 'a.txt', 'v1');
    const { host } = countedHost({ git: new Map([[file, changed]]) });
    const policy = new FileWritePolicy(host);
    ownWrite(policy.forAgent({ agentId: 'a', requestId: () => 'r1' }), file, await stateOf(file));
    const later = policy.forAgent({ agentId: 'a', requestId: () => 'r1' });
    later.noteUncertain(file, 'write', later.attribution(), true);
    expect(await policy.forAgent({ agentId: 'a', requestId: () => 'r2' }).evaluate(file, await stateOf(file), 'a.txt'))
      .toMatchObject({ verdict: 'decide', code: 'git-uncommitted' });
  });
});

describe('an empty chat looks at nothing (review resolution §3)', () => {
  it('creating the policy and an agent view, and asking its request, read, list, hash and ask Git nothing', async () => {
    let reads = 0;
    const { host, counts } = countedHost({ readState: async (target) => { reads++; return readTargetState(target); } });
    const writes = new FileWritePolicy(host).forAgent({ agentId: 'a', requestId: () => 'r1' });
    writes.scope();
    expect({ ...counts, reads }).toEqual({ git: 0, dirty: 0, load: 0, save: 0, reads: 0 });
  });
});

describe('folders about to be deleted', () => {
  it('refuses one holding a file with unsaved editor changes, asks for files nobody vouches for, and lets own work go', async () => {
    const root = await folder();
    const dir = path.join(root, 'build');
    const own = await fileAt(dir, 'own.txt', 'mine');
    const theirs = await fileAt(dir, 'nested/theirs.txt', 'theirs');
    const files = [{ physical: own, display: 'own.txt' }, { physical: theirs, display: 'nested/theirs.txt' }];

    const dirty = countedHost({ dirty: [theirs] });
    expect(await new FileWritePolicy(dirty.host).forAgent({ agentId: 'a' }).evaluateFolder(dir, files, 'build'))
      .toMatchObject({ verdict: 'refuse', code: 'dirty-buffer' });

    const { host } = countedHost();
    const writes = new FileWritePolicy(host).forAgent({ agentId: 'a', requestId: () => 'r1' });
    ownWrite(writes, own, await stateOf(own));
    const verdict = await writes.evaluateFolder(dir, files, 'build');
    expect(verdict).toMatchObject({ verdict: 'decide', code: 'folder-foreign' });
    expect(verdict.verdict === 'decide' && verdict.reason).toContain('"nested/theirs.txt"');
    expect(verdict.verdict === 'decide' && verdict.reason).not.toContain('"own.txt"');
    ownWrite(writes, theirs, await stateOf(theirs));
    expect(await writes.evaluateFolder(dir, files, 'build')).toMatchObject({ verdict: 'proceed' });
  });

  it('asks Git once for the whole folder, and needs nothing more for files it lists as tracked and unchanged', async () => {
    const root = await folder();
    const dir = path.join(root, 'src');
    const tracked = await fileAt(dir, 'a.txt', 'a');
    const { host, counts } = countedHost({ git: new Map([[dir, clean]]) });
    expect(await new FileWritePolicy(host).forAgent({ agentId: 'a' }).evaluateFolder(dir, [{ physical: tracked, display: 'a.txt' }], 'src'))
      .toEqual({ verdict: 'proceed', basis: 'git-clean' });
    expect(counts.git).toBe(1);
  });
});

describe('native file-change intents refuse a symbolic-link delete (P2-N1)', () => {
  it('a delete intent naming a symlink is refused before its referent is evaluated', async () => {
    const root = await folder();
    const writes = new FileWritePolicy(countedHost().host).forAgent({ agentId: 'a', requestId: () => 'r1' });
    // A file symlink to a regular file on POSIX (Codex's exact case); a junction on Windows (a file symlink needs
    // privilege there). lstat reports both as a symbolic link, and a native delete removes the link, not its target.
    if (process.platform === 'win32') {
      const dir = path.join(root, 'realdir');
      await fs.mkdir(dir);
      await fs.symlink(dir, path.join(root, 'link'), 'junction');
    } else {
      const file = path.join(root, 'real.txt');
      await fs.writeFile(file, 'referent');
      await fs.symlink(file, path.join(root, 'link'), 'file');
    }
    const prepared = await prepareNativeFileChanges(writes, [root], root, [{ path: 'link', operation: 'delete' }]);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) {
      expect(prepared.reason).toMatch(/symbolic link/);
    }
  });
});

describe('serialising changes to one target inside this host', () => {
  it('runs changes to the same target one after another, in arrival order, and others alongside', async () => {
    const policy = FileWritePolicy.unhosted();
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = policy.serialize('/w/a.txt', async () => { log.push('a1 start'); await gate; log.push('a1 end'); });
    const second = policy.serialize('/w/a.txt', async () => { log.push('a2'); });
    const other = policy.serialize('/w/b.txt', async () => { log.push('b'); });
    await other;
    expect(log).toEqual(['a1 start', 'b']);
    release();
    await Promise.all([first, second]);
    expect(log).toEqual(['a1 start', 'b', 'a1 end', 'a2']);
  });
});

describe('committing a host write (handoff §4)', () => {
  it('creates a new file and its missing folders, and reports the folders it made', async () => {
    const root = await folder();
    const target = path.join(root, 'a', 'b', 'c.txt');
    const outcome = await commitFileBytes(target, Buffer.from('new'), { observed: { exists: false }, recheck: async () => undefined, replace: true });
    expect(outcome).toMatchObject({ status: 'committed', createdFolders: [path.join(root, 'a'), path.join(root, 'a', 'b')] });
    expect(await fs.readFile(target, 'utf8')).toBe('new');
  });

  it('writes nothing into a folder it made through a link that appeared after the last look (file effects design §3)', async () => {
    const root = await folder();
    const outside = await folder();
    // The plan was made for root/a/b/c.txt with nothing on the way; a link now holds "a".
    await fs.symlink(outside, path.join(root, 'a'), process.platform === 'win32' ? 'junction' : 'dir');
    const outcome = await commitFileBytes(path.join(root, 'a', 'b', 'c.txt'), Buffer.from('x'), {
      observed: { exists: false }, recheck: async () => undefined, replace: true,
    });
    expect(outcome).toMatchObject({ status: 'not-committed', reason: expect.stringMatching(/leads somewhere else/) });
    // The folder it made there was its own, and is gone again; nothing else was touched.
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('reports a write whose read-back differs as uncertain, never as made (handoff §4.3)', async () => {
    const root = await folder();
    const target = await fileAt(root, 'a.txt', 'old');
    const outcome = await commitFileBytes(target, Buffer.from('new'), {
      observed: await stateOf(target),
      recheck: async () => undefined,
      replace: true,
      readBack: async () => ({ state: { exists: true, kind: 'file', size: 5, sha256: 'f'.repeat(64) } }),
    });
    expect(outcome).toMatchObject({ status: 'effect-uncertain', reason: expect.stringMatching(/not what was written/) });
  });

  it('never replaces a file that appears before a new one is created, and removes only the folders it made', async () => {
    const root = await folder();
    const target = path.join(root, 'a', 'c.txt');
    const outcome = await commitFileBytes(target, Buffer.from('mine'), {
      observed: { exists: false },
      recheck: async () => { await fs.writeFile(target, 'theirs'); return undefined; },
      replace: true,
    });
    expect(outcome).toMatchObject({ status: 'not-committed' });
    expect(await fs.readFile(target, 'utf8')).toBe('theirs');
  });

  it('replaces an existing file through a sibling, and leaves the file and no sibling when the last look says no', async () => {
    const root = await folder();
    const target = await fileAt(root, 'a.txt', 'old');
    const observed = await stateOf(target);
    const blocked = await commitFileBytes(target, Buffer.from('new'), {
      observed,
      recheck: (() => { let calls = 0; return async () => (++calls === 2 ? 'changed meanwhile' : undefined); })(),
      replace: true,
    });
    expect(blocked).toEqual({ status: 'not-committed', reason: 'changed meanwhile' });
    expect(await fs.readFile(target, 'utf8')).toBe('old');
    expect(await fs.readdir(root)).toEqual(['a.txt']);

    const done = await commitFileBytes(target, Buffer.from('new'), { observed, recheck: async () => undefined, replace: true });
    expect(done.status).toBe('committed');
    expect(await fs.readFile(target, 'utf8')).toBe('new');
    expect(await fs.readdir(root)).toEqual(['a.txt']);
  });

  it('does not replace a read-only file, which could not have been written in place either (handoff §4.2)', async () => {
    const root = await folder();
    const target = await fileAt(root, 'locked.txt', 'read-only');
    await fs.chmod(target, 0o444);
    try {
      const outcome = await commitFileBytes(target, Buffer.from('new'), { observed: await stateOf(target), recheck: async () => undefined, replace: true });
      expect(outcome).toMatchObject({ status: 'not-committed', reason: expect.stringMatching(/^the file is read-only/) });
      expect(await fs.readFile(target, 'utf8')).toBe('read-only');
      expect(await fs.readdir(root)).toEqual(['locked.txt']);
    } finally {
      await fs.chmod(target, 0o644);
    }
  });

  it('keeps the permission bits of a file it replaces (handoff §4.2: no implicit chmod)', async () => {
    const root = await folder();
    const target = await fileAt(root, 'run.sh', 'echo old');
    // POSIX keeps all of these bits; Windows keeps only whether the file is read-only, and this one is not.
    await fs.chmod(target, 0o750);
    const before = (await fs.stat(target)).mode & 0o777;
    const done = await commitFileBytes(target, Buffer.from('echo new'), { observed: await stateOf(target), recheck: async () => undefined, replace: true });
    expect(done.status).toBe('committed');
    expect((await fs.stat(target)).mode & 0o777).toBe(before);
  });

  it('a state equals itself only with the same bytes and identity', async () => {
    const root = await folder();
    const target = await fileAt(root, 'a.txt', 'x');
    const before = await stateOf(target);
    expect(sameTargetState(before, await stateOf(target))).toBe(true);
    await fs.rm(target);
    await fs.writeFile(target, 'x');
    const recreated = await stateOf(target);
    expect(recreated.sha256).toBe(before.sha256);
    // On a file system that reuses the identity at once, the bytes still decide; elsewhere a new identity differs.
    expect(sameTargetState(before, recreated)).toBe(before.ino === recreated.ino);
    expect(sameTargetState({ exists: true, kind: 'file', size: 1 }, { exists: true, kind: 'file', size: 1 })).toBe(false);
  });
});

describe('Git state of exactly one path', () => {
  function git(cwd: string, ...args: string[]): void {
    const result = spawnSync('git', ['-c', 'user.email=p2@example.invalid', '-c', 'user.name=P2', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  }

  it('tells tracked and unchanged, changed, untracked and ignored apart, and a folder outside any repository', async () => {
    const outside = await folder();
    expect(await gitPathStatus(await fileAt(outside, 'plain.txt', 'x'), 'file')).toEqual({ repository: false });

    const repo = await folder();
    await fileAt(repo, '.gitignore', 'build/\n');
    const tracked = await fileAt(repo, 'src/a.txt', 'a\n');
    const edited = await fileAt(repo, 'src/b.txt', 'b\n');
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    await fs.writeFile(edited, 'b edited\n');
    const fresh = await fileAt(repo, 'src/new.txt', 'n\n');
    const ignored = await fileAt(repo, 'build/out.js', 'o\n');

    expect(await gitPathStatus(tracked, 'file')).toEqual({ repository: true, entries: [] });
    expect(await gitPathStatus(edited, 'file')).toMatchObject({ repository: true, entries: [{ state: 'changed' }] });
    expect(await gitPathStatus(fresh, 'file')).toMatchObject({ repository: true, entries: [{ state: 'untracked' }] });
    expect(await gitPathStatus(ignored, 'file')).toMatchObject({ repository: true, entries: [{ state: 'ignored' }] });

    const src = await gitPathStatus(path.join(repo, 'src'), 'directory');
    expect(src.repository).toBe(true);
    const entries = src.repository === true ? src.entries.map((entry) => ({ ...entry, path: realpathSync.native(entry.path) })) : [];
    expect(entries).toEqual(expect.arrayContaining([
      { path: edited, folder: false, state: 'changed' },
      { path: fresh, folder: false, state: 'untracked' },
    ]));
    expect(entries.some((entry) => entry.path === tracked)).toBe(false);
  });

  it('reads a rename or copy entry as one entry, skipping its source field', () => {
    const top = path.resolve('/repo');
    expect(parsePorcelainZ('R  new.txt\0old.txt\0?? other.txt\0', top, top)).toEqual([
      { path: path.resolve(top, 'new.txt'), folder: false, state: 'changed' },
      { path: path.resolve(top, 'other.txt'), folder: false, state: 'untracked' },
    ]);
    expect(parsePorcelainZ('!! build/\0', top, top)).toEqual([{ path: path.resolve(top, 'build'), folder: true, state: 'ignored' }]);
  });
});
