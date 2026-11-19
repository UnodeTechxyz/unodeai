import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchPathAccess, SessionLocalReadScopeConsent, type PathAccessChoice } from '../localReadScope';
import { WorkspaceTools } from '../WorkspaceTools';
import { shortNameOf } from './pathSafetyFixtures';
import { FileWritePolicy } from '../fileWritePolicy';

const cleanup: string[] = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-path-access-'));
  cleanup.push(root);
  const folder = path.join(root, 'granted');
  await fs.mkdir(folder);
  const file = path.join(folder, 'a.txt');
  const outside = path.join(root, 'outside.txt');
  await fs.writeFile(file, 'original');
  await fs.writeFile(outside, 'outside');
  const owner = new SessionLocalReadScopeConsent(async () => false);
  let live = true;
  const request = { requestId: 'request-1', isCurrent: () => live };
  const grant = (target: string, choice: PathAccessChoice = { permission: 'readwrite', lifetime: 'request' }) =>
    owner.requestPathAccess(target, request, async () => choice);
  return { root, folder, file, outside, owner, request, grant, end: () => { live = false; } };
}

describe('deliberate path access in the existing session scope owner', () => {
  it('creating a new outside folder first proposes its nearest existing folder tree explicitly', async () => {
    const h = await fixture();
    const workspace = path.join(h.root, 'workspace');
    await fs.mkdir(workspace);
    const target = path.join(h.folder, 'new', 'nested', 'report.txt');
    const grant = await h.owner.requestPathAccess(target, h.request, async (proposal) => {
      expect(proposal.kind).toBe('directory');
      expect(proposal.realPath).toBe(realpathSync.native(h.folder));
      return { permission: 'readwrite', lifetime: 'request' };
    });
    expect(grant!.target.kind).toBe('directory');
    const tools = new WorkspaceTools(workspace, new Set(['read', 'write']));
    tools.setLivePathAccess(() => h.owner.pathAccessFor('request-1'));
    expect((await tools.run('write_file', { path: target, content: 'created' })).status).toBe('success');
    expect(await fs.readFile(target, 'utf8')).toBe('created');
    expect((await tools.run('read_file', { path: h.outside })).status).not.toBe('success');
  });

  it('a complete cached search is not returned after its grant is revoked', async () => {
    const h = await fixture();
    const workspace = path.join(h.root, 'workspace');
    await fs.mkdir(workspace);
    const tools = new WorkspaceTools(workspace, new Set(['read']));
    tools.setLivePathAccess(() => h.owner.pathAccessFor('request-1'));
    const grant = await h.grant(h.folder, { permission: 'read', lifetime: 'request' });
    expect((await tools.run('search_files', { path: h.folder, query: 'original' })).output).toContain('original');
    h.owner.revokePathAccess(grant!.id);
    const result = await tools.run('search_files', { path: h.folder, query: 'original' });
    expect(result.status).not.toBe('success');
    expect(result.output).not.toContain('a.txt:1: original');
  });

  it('does not return file bytes when the captured grant ends after the read', async () => {
    const h = await fixture();
    const workspace = path.join(h.root, 'workspace');
    await fs.mkdir(workspace);
    const tools = new WorkspaceTools(workspace, new Set(['read', 'write']));
    tools.setLivePathAccess(() => h.owner.pathAccessFor('request-1'));
    const grant = await h.grant(h.file);
    const writes = FileWritePolicy.unhosted().forAgent({ agentId: 'agent' });
    const noteRead = writes.noteRead.bind(writes);
    vi.spyOn(writes, 'noteRead').mockImplementation((target, state) => {
      noteRead(target, state);
      h.owner.revokePathAccess(grant!.id);
    });
    tools.setFileWrites(writes);
    const result = await tools.run('read_file', { path: h.file });
    expect(result.status).toBe('refused');
    expect(result.output).not.toContain('original');
  });

  it.each(['file', 'folder'] as const)('a Read grant to a %s does not grant writes to a write-capable agent', async (kind) => {
    const h = await fixture();
    const workspace = path.join(h.root, 'workspace');
    await fs.mkdir(workspace);
    await h.grant(kind === 'file' ? h.file : h.folder, { permission: 'read', lifetime: 'request' });
    const tools = new WorkspaceTools(workspace, new Set(['read', 'write']));
    tools.setLivePathAccess(() => h.owner.pathAccessFor('request-1'));
    expect((await tools.run('read_file', { path: h.file })).status).toBe('success');
    expect((await tools.run('write_file', { path: h.file, content: 'must not land' })).status).not.toBe('success');
    expect(await fs.readFile(h.file, 'utf8')).toBe('original');
  });

  it('does not present an already ended request or admit an unknown permission or lifetime', async () => {
    const h = await fixture();
    let asked = 0;
    expect(await h.owner.requestPathAccess(h.file, { isCurrent: () => false }, async () => {
      asked++; return { permission: 'read', lifetime: 'session' };
    })).toBeUndefined();
    expect(asked).toBe(0);
    for (const choice of [{ permission: 'all', lifetime: 'session' }, { permission: 'readwrite', lifetime: 'forever' }]) {
      expect(await h.owner.requestPathAccess(h.file, h.request, async () => choice as never)).toBeUndefined();
    }
    expect(await h.owner.requestPathAccess(h.file, { isCurrent: () => true },
      async () => ({ permission: 'read', lifetime: 'request' }))).toBeUndefined();
    expect(h.owner.listPathAccess()).toEqual([]);
  });

  it('does not keep authority when the granted folder is replaced by a junction to another tree', async () => {
    const h = await fixture();
    const workspace = path.join(h.root, 'workspace');
    const outside = path.join(h.root, 'outside-folder');
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'a.txt'), 'outside-secret');
    await h.grant(h.folder);
    const tools = new WorkspaceTools(workspace, new Set(['read', 'write']));
    tools.setLivePathAccess(() => h.owner.pathAccessFor('request-1'));
    expect((await tools.run('read_file', { path: h.file })).status).toBe('success');
    await fs.rename(h.folder, path.join(h.root, 'old-granted'));
    await fs.symlink(outside, h.folder, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await tools.run('read_file', { path: h.file })).status).not.toBe('success');
    expect(h.owner.pathAccessFor('request-1')).toEqual([]);
  });

  it('keeps the write capability and read-only task ceiling when a broader grant exists', async () => {
    const h = await fixture();
    const workspace = path.join(h.root, 'workspace');
    await fs.mkdir(workspace);
    await h.grant(h.folder);
    const readOnly = new WorkspaceTools(workspace, new Set(['read']));
    readOnly.setLivePathAccess(() => h.owner.pathAccessFor('request-1'));
    expect((await readOnly.run('write_file', { path: h.file, content: 'no' })).status).toBe('refused');
    const scoped = new WorkspaceTools(workspace, new Set(['read', 'write']));
    scoped.setLivePathAccess(() => h.owner.pathAccessFor('request-1'));
    scoped.setTurnWorkspaceAccess({ pathBase: workspace, readRoots: [realpathSync.native(h.folder)], writeRoots: [] });
    expect((await scoped.run('read_file', { path: h.file })).status).toBe('success');
    expect((await scoped.run('write_file', { path: h.file, content: 'no' })).status).toBe('refused');
    expect(await fs.readFile(h.file, 'utf8')).toBe('original');
    // A task that may write only in the workspace keeps its write ceiling: the live Read + Write grant adds no write
    // outside it. (A task with no write root never reaches this check; it has no write capability at all.)
    const writer = new WorkspaceTools(workspace, new Set(['read', 'write']));
    writer.setLivePathAccess(() => h.owner.pathAccessFor('request-1'));
    writer.setTurnWorkspaceAccess({ pathBase: workspace, readRoots: [realpathSync.native(h.folder), realpathSync.native(workspace)],
      writeRoots: [realpathSync.native(workspace)] });
    expect((await writer.run('write_file', { path: path.join(workspace, 'inside.txt'), content: 'yes' })).status).toBe('success');
    // The ceiling narrows the grant away, so the granted folder is simply outside this task's working boundary.
    expect(await writer.run('write_file', { path: h.file, content: 'no' })).toMatchObject({ status: 'refused', reason: 'workspace-escape' });
    expect(await fs.readFile(h.file, 'utf8')).toBe('original');
  });

  it('a folder grant retains the one dangerous-delete decision for files UnodeAi did not create', async () => {
    const h = await fixture();
    const workspace = path.join(h.root, 'workspace');
    const child = path.join(h.folder, 'child');
    await fs.mkdir(workspace);
    await fs.mkdir(child);
    await fs.writeFile(path.join(child, 'personal.txt'), 'keep');
    await h.grant(h.folder);
    let decisions = 0;
    const tools = new WorkspaceTools(workspace, new Set(['read', 'write']));
    tools.setLivePathAccess(() => h.owner.pathAccessFor('request-1'));
    tools.setFileWrites(new FileWritePolicy({ workspaceId: () => 'w', gitPath: async () => ({ repository: false }) })
      .forAgent({ agentId: 'dev', requestId: () => 'request-1', decide: async () => { decisions++; return 'deny'; } }));
    expect((await tools.run('delete_dir', { path: child })).status).toBe('refused');
    expect(decisions).toBe(1);
    expect(await fs.readFile(path.join(child, 'personal.txt'), 'utf8')).toBe('keep');
  });

  it('a grant to the referent does not authorize deleting a link outside the granted folder', async () => {
    const h = await fixture();
    const workspace = path.join(h.root, 'workspace');
    const child = path.join(h.folder, 'child');
    const alias = path.join(h.root, 'outside-alias');
    await fs.mkdir(workspace);
    await fs.mkdir(child);
    await fs.symlink(child, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await h.grant(h.folder);
    const tools = new WorkspaceTools(workspace, new Set(['read', 'write']));
    tools.setLivePathAccess(() => h.owner.pathAccessFor('request-1'));
    let decisions = 0;
    tools.setFileWrites(new FileWritePolicy({ workspaceId: () => 'w', gitPath: async () => ({ repository: false }) })
      .forAgent({ agentId: 'dev', requestId: () => 'request-1', decide: async () => { decisions++; return 'once'; } }));
    const result = await tools.run('delete_dir', { path: alias });
    expect(result).toMatchObject({ status: 'refused', reason: 'scope' });
    expect(result.output).toContain('The named entry itself is outside');
    expect(decisions).toBe(0);
    expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
    expect((await fs.stat(child)).isDirectory()).toBe(true);
  });

  it('a task snapshot cannot turn a request grant into permanent file authority', async () => {
    const h = await fixture();
    const workspace = path.join(h.root, 'workspace');
    await fs.mkdir(workspace);
    const tools = new WorkspaceTools(workspace, new Set(['read', 'write']));
    tools.setLivePathAccess(() => h.owner.pathAccessFor('request-1'));
    const grant = await h.grant(h.file);
    const file = { ...grant!.target, kind: 'file' as const };
    tools.setTurnWorkspaceAccess({ pathBase: workspace, readRoots: [], writeRoots: [], readFiles: [file], writeFiles: [file] });
    expect((await tools.run('read_file', { path: h.file })).status).toBe('success');
    h.owner.revokePathAccess(grant!.id);
    expect((await tools.run('read_file', { path: h.file })).status).not.toBe('success');
    expect((await tools.run('write_file', { path: h.file, content: 'must not land' })).status).not.toBe('success');
    expect(await fs.readFile(h.file, 'utf8')).toBe('original');
  });

  it('a request grant survives subsequent turns of the same logical request and ends with that request', async () => {
    const h = await fixture();
    let turn = true;
    let request = true;
    await h.owner.requestPathAccess(h.file, { requestId: 'r', isCurrent: () => turn, requestCurrent: () => request },
      async () => ({ permission: 'read', lifetime: 'request' }));
    turn = false;
    expect(matchPathAccess(h.owner.pathAccessFor('r'), h.file, 'read')).toBeDefined();
    request = false;
    expect(h.owner.pathAccessFor('r')).toEqual([]);
    request = true;
    expect(matchPathAccess(h.owner.pathAccessFor('r'), h.file, 'read')).toBeUndefined();
  });

  it('without a grant refuses an outside junction delete while retaining writes through it into the workspace', async () => {
    const h = await fixture();
    const child = path.join(h.folder, 'child');
    const alias = path.join(h.root, 'outside-alias');
    await fs.mkdir(child);
    await fs.writeFile(path.join(child, 'personal.txt'), 'keep');
    await fs.symlink(child, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const tools = new WorkspaceTools(h.folder, new Set(['read', 'write']));
    let decisions = 0;
    tools.setFileWrites(new FileWritePolicy({ workspaceId: () => 'w', gitPath: async () => ({ repository: false }) })
      .forAgent({ agentId: 'dev', decide: async () => { decisions++; return 'once'; } }));
    expect((await tools.run('write_file', { path: path.join(alias, 'new.txt'), content: 'allowed' })).status).toBe('success');
    const beforeDelete = decisions;
    const result = await tools.run('delete_dir', { path: alias });
    expect(result).toMatchObject({ status: 'refused', reason: 'scope' });
    expect(result.output).toContain('The named entry itself is outside');
    expect(decisions).toBe(beforeDelete);
    expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(child, 'personal.txt'), 'utf8')).toBe('keep');
    expect(await fs.readFile(path.join(child, 'new.txt'), 'utf8')).toBe('allowed');
  });

  it('preserves source and fake credential text in inside and granted outside reads and searches', async () => {
    const h = await fixture();
    const workspace = path.join(h.root, 'workspace');
    await fs.mkdir(workspace);
    const secret = 'ghp_' + 'a'.repeat(30);
    const source = 'const token = await getToken(req);';
    const content = `${source}\nconst api_key = "${secret}";\n` + 'ordinary text\n'.repeat(1000) + 'END-RETAINED\n';
    await fs.writeFile(h.file, content);
    const inside = path.join(workspace, 'source.ts');
    await fs.writeFile(inside, content);
    const tools = new WorkspaceTools(workspace, new Set(['read']));
    tools.setLivePathAccess(() => h.owner.pathAccessFor('request-1'));
    await h.grant(h.folder, { permission: 'read', lifetime: 'request' });
    for (const target of [inside, h.file]) {
      const result = await tools.run('read_file', { path: target });
      expect(result.status).toBe('success');
      expect(result.output).toContain(content);
      expect(result.output).not.toContain('[redacted]');
      for (const query of ['getToken', secret]) {
        const search = await tools.run('search_files', { path: path.dirname(target), query });
        expect(search.status).toBe('success');
        expect(search.output).toContain(query === 'getToken' ? source : `const api_key = "${secret}";`);
      }
      expect(await fs.readFile(target, 'utf8')).toBe(content);
    }
  });

  it('preserves credential-shaped file names in granted directory listings', async () => {
    const h = await fixture();
    const workspace = path.join(h.root, 'workspace');
    await fs.mkdir(workspace);
    const name = `token=ghp_${'a'.repeat(30)}.txt`;
    await fs.writeFile(path.join(h.folder, name), 'fixture');
    await h.grant(h.folder, { permission: 'read', lifetime: 'request' });
    const tools = new WorkspaceTools(workspace, new Set(['read']));
    tools.setLivePathAccess(() => h.owner.pathAccessFor('request-1'));
    const result = await tools.run('list_dir', { path: h.folder });
    expect(result.status).toBe('success');
    expect(result.output).toContain(name);
  });

  it('reaches a running host tool on its next call without changing its working directory or widening an exact file', async () => {
    const h = await fixture();
    const workspace = path.join(h.root, 'workspace');
    await fs.mkdir(workspace);
    const tools = new WorkspaceTools(workspace, new Set(['read', 'write']));
    tools.setLivePathAccess(() => h.owner.pathAccessFor('request-1'));
    expect((await tools.run('read_file', { path: h.file })).status).not.toBe('success');
    const grant = await h.grant(h.file);
    expect((await tools.run('read_file', { path: h.file })).output).toContain('original');
    expect((await tools.run('write_file', { path: h.file, content: 'updated' })).status).toBe('success');
    expect(await fs.readFile(h.file, 'utf8')).toBe('updated');
    expect((tools as any).commandCwd).toBe(workspace);
    expect((await tools.run('write_file', { path: h.outside, content: 'must not land' })).status).not.toBe('success');
    h.owner.revokePathAccess(grant!.id);
    expect((await tools.run('read_file', { path: h.file })).status).not.toBe('success');
    expect((await tools.run('write_file', { path: h.file, content: 'revoked' })).status).not.toBe('success');
    expect(await fs.readFile(h.file, 'utf8')).toBe('updated');
  });

  it('rechecks a captured host write lease after Ask even if the path was regranted during the wait', async () => {
    const h = await fixture();
    const workspace = path.join(h.root, 'workspace');
    await fs.mkdir(workspace);
    const grant = await h.grant(h.file);
    let asked = 0;
    const tools = new WorkspaceTools(workspace, new Set(['read', 'write']), 'agent',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      () => true, async () => {
        asked++;
        h.owner.revokePathAccess(grant!.id);
        await h.grant(h.file, { permission: 'readwrite', lifetime: 'session' });
        return 'once';
      });
    tools.setLivePathAccess(() => h.owner.pathAccessFor('request-1'));
    // v0.9.101 (the access table, R2 §3): the failure at the write boundary is reported as a refused write of the target.
    const told: Array<[string, string | undefined]> = [];
    tools.setOutsideRootObserver((target, access) => { told.push([target, access]); });
    await tools.run('read_file', { path: h.file });
    const result = await tools.run('write_file', { path: h.file, content: 'stale approval' });
    expect(asked).toBe(1);
    expect(result.status).not.toBe('success');
    expect(await fs.readFile(h.file, 'utf8')).toBe('original');
    expect(told).toContainEqual([path.resolve(h.file), 'readwrite']);
  });

  it.each(['expiry', 'Stop'] as const)('%s during Ask prevents the old write even if a new session grant exists', async (ending) => {
    const h = await fixture();
    const workspace = path.join(h.root, 'workspace');
    await fs.mkdir(workspace);
    await h.grant(h.file);
    const controller = new AbortController();
    let asked = 0;
    const tools = new WorkspaceTools(workspace, new Set(['read', 'write']), 'agent',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      () => true, async () => {
        asked++;
        h.end();
        if (ending === 'Stop') controller.abort();
        await h.owner.requestPathAccess(h.file, { isCurrent: () => true },
          async () => ({ permission: 'readwrite', lifetime: 'session' }));
        return 'once';
      });
    tools.setLivePathAccess(() => h.owner.pathAccessFor('request-1'));
    await tools.run('read_file', { path: h.file });
    const result = await tools.run('write_file', { path: h.file, content: 'must not land' }, { signal: controller.signal });
    expect(asked).toBe(1);
    expect(result.status).not.toBe('success');
    expect(await fs.readFile(h.file, 'utf8')).toBe('original');
  });

  it('keeps an exact file exact, read-only, and bound to its request after newer irrelevant grants', async () => {
    const h = await fixture();
    await h.grant(h.file, { permission: 'read', lifetime: 'request' });
    for (let i = 0; i < 4; i++) {
      const file = path.join(h.root, `later-${i}.txt`);
      await fs.writeFile(file, 'irrelevant');
      await h.grant(file, { permission: 'read', lifetime: 'session' });
    }
    const scope = () => h.owner.pathAccessFor('request-1');
    expect(matchPathAccess(scope(), h.file, 'read')).toBeDefined();
    expect(matchPathAccess(scope(), h.file, 'readwrite')).toBeUndefined();
    expect(matchPathAccess(scope(), h.outside, 'read')).toBeUndefined();
    const sibling = path.join(h.folder, 'sibling.txt');
    await fs.writeFile(sibling, 'sibling');
    expect(matchPathAccess(scope(), sibling, 'read')).toBeUndefined();
    expect(matchPathAccess(scope(), h.folder, 'read')).toBeUndefined();
    expect(matchPathAccess(h.owner.pathAccessFor('request-2'), h.file, 'read')).toBeUndefined();
    h.end();
    expect(matchPathAccess(scope(), h.file, 'read')).toBeUndefined();
  });

  it('ends session grants at session end and never revives a captured lease after a regrant', async () => {
    const h = await fixture();
    const granted = await h.grant(h.folder, { permission: 'readwrite', lifetime: 'session' });
    h.end();
    const scope = () => h.owner.pathAccessFor('request-2');
    const lease = matchPathAccess(scope(), h.file, 'readwrite')!;
    expect(lease.current()).toBe(true);
    h.owner.revokePathAccess(granted!.id);
    expect(lease.current()).toBe(false);
    await h.owner.requestPathAccess(h.folder, { isCurrent: () => true }, async () => ({ permission: 'readwrite', lifetime: 'session' }));
    expect(matchPathAccess(scope(), h.file, 'readwrite')).toBeDefined();
    expect(lease.current()).toBe(false);
    h.owner.endPathAccessSession();
    expect(matchPathAccess(scope(), h.file, 'readwrite')).toBeUndefined();
  });

  it('does not admit a delayed decision after Stop or session end', async () => {
    for (const end of ['request', 'session'] as const) {
      const h = await fixture();
      let answer!: (choice: PathAccessChoice) => void;
      const pending = h.owner.requestPathAccess(h.file, h.request, () => new Promise((resolve) => { answer = resolve; }));
      await Promise.resolve();
      if (end === 'request') h.end(); else h.owner.endPathAccessSession();
      answer({ permission: 'readwrite', lifetime: 'session' });
      expect(await pending).toBeUndefined();
      expect(h.owner.pathAccessFor('request-1')).toEqual([]);
    }
  });

  it('refuses a grant whose file was replaced by a link during the decision', async () => {
    const h = await fixture();
    let answer!: (choice: PathAccessChoice) => void;
    const pending = h.owner.requestPathAccess(h.file, h.request, () => new Promise((resolve) => { answer = resolve; }));
    await Promise.resolve();
    await fs.unlink(h.file);
    // A junction is available without Windows symlink privilege; point a directory at the outside parent instead.
    await fs.symlink(h.root, h.file, process.platform === 'win32' ? 'junction' : 'dir');
    answer({ permission: 'readwrite', lifetime: 'request' });
    expect(await pending).toBeUndefined();
    expect(h.owner.pathAccessFor('request-1')).toEqual([]);
  });

  it('does not follow a junction out of a granted subtree and notices a changed target on a captured lease', async () => {
    const h = await fixture();
    await h.grant(h.folder);
    const scope = () => h.owner.pathAccessFor('request-1');
    const lease = matchPathAccess(scope(), h.file, 'readwrite')!;
    await fs.symlink(h.root, path.join(h.folder, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(matchPathAccess(scope(), path.join(h.folder, 'escape', 'outside.txt'), 'read')).toBeUndefined();
    await fs.unlink(h.file);
    await fs.symlink(h.root, h.file, process.platform === 'win32' ? 'junction' : 'dir');
    expect(lease.current()).toBe(false);
  });

  it('coalesces a pending target without holding independent access', async () => {
    const h = await fixture();
    let answer!: (choice: PathAccessChoice) => void;
    let prompts = 0;
    const choose = () => { prompts++; return new Promise<PathAccessChoice>((resolve) => { answer = resolve; }); };
    const first = h.owner.requestPathAccess(h.file, h.request, choose);
    const duplicate = h.owner.requestPathAccess(h.file, h.request, choose);
    await Promise.resolve();
    expect(prompts).toBe(1);
    await h.grant(h.outside);
    expect(matchPathAccess(h.owner.pathAccessFor('request-1'), h.outside, 'read')).toBeDefined();
    answer({ permission: 'read', lifetime: 'request' });
    expect(await first).toBe(await duplicate);
  });
});

describe.runIf(process.platform === 'win32')('live exact grants on Windows', () => {
  it('refuses alternate data streams without reading or writing their bytes', async () => {
    const h = await fixture();
    await fs.writeFile(`${h.file}:hidden`, 'stream-secret');
    await h.grant(h.file);
    expect(matchPathAccess(h.owner.pathAccessFor('request-1'), `${h.file}:hidden`, 'read')).toBeUndefined();
    expect(matchPathAccess(h.owner.pathAccessFor('request-1'), `${h.file}::$DATA`, 'readwrite')).toBeUndefined();
    await expect(h.grant(`${h.file}:hidden`)).rejects.toThrow(/alternate data stream/);
    expect(await fs.readFile(`${h.file}:hidden`, 'utf8')).toBe('stream-secret');
  });

  it('does not admit a different file through its real Windows short name', async (context) => {
    const h = await fixture();
    const folderName = 'outside directory with a long name';
    const outside = path.join(h.root, folderName);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'a.txt'), 'outside');
    const short = shortNameOf(h.root, folderName);
    let alias = short ? path.join(h.root, short, 'a.txt') : undefined;
    // New short names may be disabled while real system 8.3 names still exist. Exercise one that actually resolves.
    if (!alias) {
      const existing = path.join(path.parse(h.root).root, 'PROGRA~1', 'nodejs', 'node.exe');
      try { if (!realpathSync.native(existing).includes('~')) alias = existing; } catch { /* unavailable on this host */ }
    }
    if (!alias) context.skip('this volume has no available 8.3 short file path');
    await h.grant(h.file);
    expect(matchPathAccess(h.owner.pathAccessFor('request-1'), alias!, 'read')).toBeUndefined();
  });

  it('compares extended paths by their real target and Windows case', async () => {
    const h = await fixture();
    await h.grant(h.file);
    const scope = h.owner.pathAccessFor('request-1');
    expect(matchPathAccess(scope, path.toNamespacedPath(h.file), 'read')).toBeDefined();
    expect(matchPathAccess(scope, h.file.toUpperCase(), 'read')).toBeDefined();
    expect(matchPathAccess(scope, path.toNamespacedPath(h.outside), 'readwrite')).toBeUndefined();
    expect(matchPathAccess(scope, `\\\\.\\${h.outside}`, 'read')).toBeUndefined();
    const workspace = path.join(h.root, 'workspace');
    await fs.mkdir(workspace);
    const tools = new WorkspaceTools(workspace, new Set(['read', 'write']));
    tools.setLivePathAccess(() => h.owner.pathAccessFor('request-1'));
    expect((await tools.run('read_file', { path: path.toNamespacedPath(h.file) })).status).toBe('success');
    expect((await tools.run('write_file', { path: path.toNamespacedPath(h.file), content: 'updated' })).status).toBe('success');
  });
});
