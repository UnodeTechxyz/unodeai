import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceTools, type CheckpointRecorder, type WriteApprover } from '../WorkspaceTools';
import { fullAccessTargetRoot } from '../FullFileAccess';
import { FileWritePolicy, type HostObservedFileEffect, type OverwriteDecisionRequest } from '../fileWritePolicy';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';
import { admitUserTurn, attachment, attachmentIds, PNG, saveHost } from './attachmentSaveFixtures';
import { renderDocx, type DocumentZip } from '../../content/document/DocxRenderer';
import { OpenAICompatBackend } from '../OpenAICompatBackend';
import { SessionLocalReadScopeConsent } from '../localReadScope';
import { CommandPolicy } from '../CommandPolicy';
import { asProvider, BASH_SHELL } from './shellFixtures';
import { CheckpointStore } from '../Checkpoints';

afterEach(removeTemporaryFolders);

async function host(approve?: WriteApprover, checkpoint?: CheckpointRecorder) {
  const root = await temporaryFolder('unode-full-host-');
  const outside = await temporaryFolder('unode-full-outside-');
  const state = { full: false, revision: 0, trusted: true };
  const tools = new WorkspaceTools(root, new Set(['read', 'write']), 'dev', undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, checkpoint, () => !!approve, approve,
    undefined, undefined, undefined, [], () => state.trusted);
  tools.setFullFileAccess(() => state.full, () => state.revision);
  return { root, outside, tools, state };
}

async function directoryLinkHost(decide?: (request: OverwriteDecisionRequest) => Promise<'once' | 'deny'>, review?: WriteApprover) {
  const checkpoints = new CheckpointStore();
  const h = await host(review, (entry) => { checkpoints.record({ ...entry, agentName: 'Dev' }); }); h.state.full = true;
  const target = path.join(h.root, 'target'); await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'personal.txt'), 'keep personal data');
  const link = path.join(h.outside, 'outside-link');
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const effects: HostObservedFileEffect[] = [], decisions: OverwriteDecisionRequest[] = [];
  const writes = new FileWritePolicy({ workspaceId: () => 'w', gitPath: async () => ({ repository: false }),
    onEffect: (effect) => { effects.push(effect); } }).forAgent({ agentId: 'dev', requestId: () => 'r1',
    decide: async (request) => { decisions.push(request); return decide ? decide(request) : 'once'; } });
  h.tools.setFileWrites(writes);
  return { ...h, target, link, writes, effects, decisions, checkpoints };
}

describe('live Full access through host file tools', () => {
  it('derives the physical target volume/share without assuming the working drive', () => {
    expect(fullAccessTargetRoot('D:\\Reports\\output.txt', 'win32')).toBe('D:\\');
    expect(fullAccessTargetRoot('\\\\server\\share\\Reports\\output.txt', 'win32')).toBe('\\\\server\\share\\');
    expect(fullAccessTargetRoot('\\\\?\\UNC\\server\\share\\Reports\\output.txt', 'win32')).toBe('\\\\server\\share\\');
    expect(fullAccessTargetRoot('\\\\?\\E:\\Reports\\output.txt', 'win32')).toBe('E:\\');
    expect(fullAccessTargetRoot('/outside/report.txt', 'linux')).toBe('/');
  });

  it('enables real outside reads writes edits listings and searches on the next call, without a cwd change', async () => {
    const h = await host();
    const target = path.join(h.outside, 'source.ts');
    await fs.writeFile(target, 'const token = await getToken(req);\n');
    const cwd = (h.tools as any).commandCwd;
    expect((await h.tools.run('read_file', { path: target })).status).toBe('refused');
    h.state.full = true; h.state.revision++;
    expect((await h.tools.run('read_file', { path: target })).output).toContain('const token = await getToken(req);');
    expect((await h.tools.run('apply_edit', { path: target, old_string: 'getToken(req)', new_string: 'getToken(request)' })).status).toBe('success');
    const created = path.join(h.outside, 'nested', 'result.txt');
    expect((await h.tools.run('write_file', { path: created, content: 'complete result' })).status).toBe('success');
    expect(await fs.readFile(created, 'utf8')).toBe('complete result');
    expect((await h.tools.run('list_dir', { path: h.outside })).output).toContain('source.ts');
    expect((await h.tools.run('search_files', { path: h.outside, query: 'getToken' })).output).toContain('getToken(request)');
    expect((h.tools as any).commandCwd).toBe(cwd);
    h.state.full = false; h.state.revision++;
    expect((await h.tools.run('read_file', { path: target })).status).toBe('refused');
    expect((await h.tools.run('write_file', { path: created, content: 'must not land' })).status).toBe('refused');
    expect(await fs.readFile(created, 'utf8')).toBe('complete result');
  });

  it('follows an outside junction by its actual target only while Full access is effective', async () => {
    const h = await host();
    const alias = path.join(h.root, 'outside-link');
    await fs.symlink(h.outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(path.join(h.outside, 'old.txt'), 'outside');
    expect((await h.tools.run('read_file', { path: path.join(alias, 'old.txt') })).status).not.toBe('success');
    h.state.full = true;
    expect((await h.tools.run('read_file', { path: path.join(alias, 'old.txt') })).output).toBe('outside');
    expect((await h.tools.run('write_file', { path: path.join(alias, 'new.txt'), content: 'physical destination' })).status).toBe('success');
    expect(await fs.readFile(path.join(h.outside, 'new.txt'), 'utf8')).toBe('physical destination');
    expect(h.tools.fileEffectTarget('write_file', { path: path.join(alias, 'new.txt') }))
      .toBe(h.tools.fileEffectTarget('write_file', { path: path.join(h.outside, 'new.txt') }));
    const anotherOutside = await temporaryFolder('unode-full-alias-identity-');
    const outsideAlias = path.join(anotherOutside, 'alias');
    await fs.symlink(h.outside, outsideAlias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(h.tools.fileEffectTarget('write_file', { path: path.join(outsideAlias, 'new.txt') }))
      .toBe(h.tools.fileEffectTarget('write_file', { path: path.join(h.outside, 'new.txt') }));
  });

  it('Full access does not ask an overlapping discovery-root question', async () => {
    const h = await host(); h.state.full = true;
    await fs.writeFile(path.join(h.outside, 'input.txt'), 'input');
    const chooser = vi.fn(async () => false);
    h.tools.setLocalReadScopeAccess([h.outside], new SessionLocalReadScopeConsent(chooser));
    expect((await h.tools.run('read_file', { path: path.join(h.outside, 'input.txt') })).output).toBe('input');
    expect(chooser).not.toHaveBeenCalled();
  });

  it('threads the same live Full access getter through the actual OpenAI backend without starting a model request', async () => {
    const h = await host();
    const fetch = vi.fn(async () => { throw new Error('no model request is authorized by choosing Full access'); });
    const backend = new OpenAICompatBackend({ id: 'dev', name: 'Dev', role: 'developer', skill: '',
      provider: { providerId: 'roam', apiKeySecretName: 'FAKE_KEY' }, model: 'fake-model', systemPrompt: '',
      autoApprove: true, allowedTools: ['read', 'write'], workingDirectory: h.root }, fetch,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, { fullFileAccess: () => h.state.full, fullFileAccessRevision: () => h.state.revision });
    const tools = (backend as any).tools as WorkspaceTools;
    const target = path.join(h.outside, 'result.txt');
    expect((await tools.run('write_file', { path: target, content: 'no' })).status).toBe('refused');
    h.state.full = true; h.state.revision++;
    expect((await tools.run('write_file', { path: target, content: 'actual backend' })).status).toBe('success');
    expect(await fs.readFile(target, 'utf8')).toBe('actual backend');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the current task ceiling exact instead of widening it to the volume', async () => {
    const h = await host();
    h.state.full = true;
    const exact = path.join(h.outside, 'exact.txt');
    await fs.writeFile(exact, 'old');
    const readOnly = path.join(h.outside, 'read-only.txt');
    await fs.writeFile(readOnly, 'read only');
    const file = { kind: 'file' as const, lexicalPath: exact, realPath: await fs.realpath(exact), existed: true };
    const readFile = { kind: 'file' as const, lexicalPath: readOnly, realPath: await fs.realpath(readOnly), existed: true };
    h.tools.setTurnWorkspaceAccess({ pathBase: h.root, readRoots: [], writeRoots: [], readFiles: [file, readFile], writeFiles: [file] });
    expect((await h.tools.run('read_file', { path: exact })).output).toContain('old');
    expect((await h.tools.run('write_file', { path: exact, content: 'exact change' })).status).toBe('success');
    expect((await h.tools.run('write_file', { path: path.join(h.outside, 'sibling.txt'), content: 'no' })).status).toBe('refused');
    expect((await h.tools.run('write_file', { path: readOnly, content: 'no' })).status).toBe('refused');
    expect((await h.tools.run('list_dir', { path: h.outside })).status).toBe('refused');
    h.state.full = false; h.state.revision++;
    expect((await h.tools.run('write_file', { path: exact, content: 'not permanent' })).status).toBe('refused');
    expect(await fs.readFile(exact, 'utf8')).toBe('exact change');
  });

  it('does not turn the read half of a mixed task into outside write authority', async () => {
    const h = await host(); h.state.full = true;
    const writable = path.join(h.outside, 'writable'); await fs.mkdir(writable);
    const readOnly = path.join(h.outside, 'read-only.txt'); await fs.writeFile(readOnly, 'input');
    h.tools.setTurnWorkspaceAccess({ pathBase: h.root, readRoots: [h.outside], writeRoots: [writable] });
    expect((await h.tools.run('read_file', { path: readOnly })).output).toContain('input');
    expect((await h.tools.run('write_file', { path: readOnly, content: 'no' })).status).toBe('refused');
    expect((await h.tools.run('write_file', { path: path.join(writable, 'out.txt'), content: 'yes' })).status).toBe('success');
    expect(await fs.readFile(readOnly, 'utf8')).toBe('input');
  });

  it('a read-only task and explicit tool Off remain read-only under Full access', async () => {
    const h = await host();
    h.state.full = true;
    h.tools.setTurnWorkspaceAccess({ pathBase: h.root, readRoots: [h.outside], writeRoots: [] });
    await fs.writeFile(path.join(h.outside, 'source.txt'), 'input');
    expect((await h.tools.run('read_file', { path: path.join(h.outside, 'source.txt') })).output).toContain('input');
    expect((await h.tools.run('write_file', { path: path.join(h.outside, 'out.txt'), content: 'no' })).status).toBe('refused');
    const off = new WorkspaceTools(h.root, new Set(['read']));
    off.setFullFileAccess(() => true);
    expect((await off.run('write_file', { path: path.join(h.outside, 'out.txt'), content: 'no' })).status).toBe('refused');
    await expect(fs.stat(path.join(h.outside, 'out.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a read under Full access by tools that do not write does not say the agent cannot write there', async () => {
    // Field, 4c06a304 S5C: a Claude CLI agent reads with these tools and writes with its own, and was told its writes
    // stayed in the working folder before it wrote outside it, as Full access allows.
    const h = await host();
    await fs.writeFile(path.join(h.outside, 'source.txt'), 'input');
    const cliTools = new WorkspaceTools(h.root, new Set(['read']));
    cliTools.setFullFileAccess(() => true);
    const read = await cliTools.run('read_file', { path: path.join(h.outside, 'source.txt') });
    expect(read.status).toBe('success');
    expect(read.output).toContain('input');
    expect(read.output).not.toContain('read-only in your tree');
    expect(read.output).not.toContain('stay in your command working folder');
  });

  it('a declared outside self-execution contract narrows Full access without retaining it after removal', async () => {
    const h = await host();
    const contract = { folderAccess: [{ path: h.outside, permission: 'readwrite' as const }] };
    expect(h.tools.setContractTaskScope(contract)).toBe(false);
    h.state.full = true;
    expect(h.tools.setContractTaskScope(contract)).toBe(true);
    const target = path.join(h.outside, 'contract-output.txt');
    expect((await h.tools.run('write_file', { path: target, content: 'contract result' })).status).toBe('success');
    expect((await h.tools.run('write_file', { path: path.join(h.root, 'outside-contract.txt'), content: 'no' })).status).toBe('refused');
    h.state.full = false; h.state.revision++;
    expect((await h.tools.run('write_file', { path: target, content: 'stale authority' })).status).toBe('refused');
    expect(await fs.readFile(target, 'utf8')).toBe('contract result');
  });

  it('an admitted outside folder task actually runs an allowed command there without changing cwd on Full selection alone', async () => {
    const h = await host(); h.state.full = true;
    const ran: string[] = [];
    const provider = asProvider(async (_command, options) => {
      ran.push(options.cwd); await fs.writeFile(path.join(options.cwd, 'command-proof.txt'), 'actual cwd effect');
      return { code: 0, output: 'ready' };
    });
    const tools = new WorkspaceTools(h.root, new Set(['read', 'write', 'execute']), 'dev', undefined,
      new CommandPolicy('all'), undefined, undefined, undefined, undefined, provider);
    tools.setFullFileAccess(() => h.state.full, () => h.state.revision);
    expect((tools as any).commandCwd).toBe(path.resolve(h.root));
    tools.setTurnWorkspaceAccess({ pathBase: h.outside, commandCwd: h.outside, readRoots: [h.outside], writeRoots: [h.outside] });
    const input = path.join(h.outside, 'input.txt'); await fs.writeFile(input, 'input');
    expect((await tools.run('run_command', { command: `echo "${input.replace(/\\/g, '/')}"` })).status).toBe('success');
    expect(ran).toEqual([await fs.realpath(h.outside)]);
    expect(await fs.readFile(path.join(h.outside, 'command-proof.txt'), 'utf8')).toBe('actual cwd effect');
    h.state.full = false; h.state.revision++;
    expect((await tools.run('run_command', { command: 'echo revoked' })).status).toBe('refused');
    expect(ran).toHaveLength(1);
    tools.setTurnWorkspaceAccess(undefined);
    expect((tools as any).commandCwd).toBe(path.resolve(h.root));
  });

  it.each([false, true])('revoking and re-enabling Full access during command Ask prevents a stale outside start (background=%s)', async (background) => {
    const h = await host(); h.state.full = true;
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => ({ code: 0, output: 'must not run' }));
    const startBackground = vi.fn(() => ({ ok: false as const, error: 'must not start' }));
    const provider = { ...asProvider(execute), prepareDirect: () => ({ ok: true as const,
      shell: BASH_SHELL, execute: vi.fn(), startBackground }) };
    const tools = new WorkspaceTools(h.root, new Set(['read', 'write', 'execute']), 'dev', undefined,
      new CommandPolicy('ask'), undefined, async () => { enter(); await held; return { allow: true }; },
      undefined, undefined, provider);
    tools.setFullFileAccess(() => h.state.full, () => h.state.revision);
    tools.setTurnWorkspaceAccess({ pathBase: h.outside, commandCwd: h.outside, readRoots: [h.outside], writeRoots: [h.outside] });
    const pending = tools.run('run_command', { command: 'echo ready', background });
    expect(await Promise.race([entered.then(() => 'asked'), pending])).toBe('asked');
    h.state.full = false; h.state.revision++; h.state.full = true; h.state.revision++;
    release();
    expect(await pending).toMatchObject({ status: 'refused', reason: 'task-scope' });
    expect(execute).not.toHaveBeenCalled(); expect(startBackground).not.toHaveBeenCalled();
  });

  it('Full access does not turn an exact-file task into a command working folder', async () => {
    const h = await host(); h.state.full = true;
    const target = path.join(h.outside, 'exact.txt'); await fs.writeFile(target, 'exact');
    const file = { kind: 'file' as const, lexicalPath: target, realPath: await fs.realpath(target), existed: true };
    const cwds: string[] = [];
    const execute = vi.fn(async (_command: string, options: { cwd: string }) => { cwds.push(options.cwd); return { code: 0, output: 'ran' }; });
    const tools = new WorkspaceTools(h.root, new Set(['read', 'write', 'execute']), 'dev', undefined,
      new CommandPolicy('all'), undefined, undefined, undefined, undefined, asProvider(execute));
    tools.setFullFileAccess(() => true);
    tools.setTurnWorkspaceAccess({ pathBase: h.root, readRoots: [], writeRoots: [], readFiles: [file], writeFiles: [file] });
    // v0.9.100 (the Owner): the scope gives a command no folder, so it runs in the agent's own, never beside the file.
    expect(await tools.run('run_command', { command: 'echo here' })).toMatchObject({ status: 'success' });
    expect(cwds).toEqual([h.root]);
  });

  it('a stale outside command lease after lane acquisition is refused before opening Ask', async () => {
    const h = await host(); h.state.full = true;
    const execute = vi.fn(async () => ({ code: 0, output: 'must not run' }));
    const base = asProvider(execute);
    const provider = { ...base, acquire: async (options: { cwd: string }) => {
      const lane = await base.acquire(options);
      h.state.full = false; h.state.revision++; h.state.full = true; h.state.revision++;
      return lane;
    } };
    const approve = vi.fn(async () => ({ allow: true }));
    const tools = new WorkspaceTools(h.root, new Set(['read', 'write', 'execute']), 'dev', undefined,
      new CommandPolicy('ask'), undefined, approve, undefined, undefined, provider);
    tools.setFullFileAccess(() => h.state.full, () => h.state.revision);
    tools.setTurnWorkspaceAccess({ pathBase: h.outside, commandCwd: h.outside, readRoots: [h.outside], writeRoots: [h.outside] });
    expect(await tools.run('run_command', { command: 'echo ready' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
    expect(approve).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(base.released).toBe(1);
  });

  it('does not reuse an outside search after Full access is removed', async () => {
    const h = await host();
    h.state.full = true;
    await fs.writeFile(path.join(h.outside, 'source.txt'), 'outside needle');
    expect((await h.tools.run('search_files', { path: h.outside, query: 'needle' })).output).toContain('outside needle');
    h.state.full = false; h.state.revision++;
    const next = await h.tools.run('search_files', { path: h.outside, query: 'needle' });
    expect(next.status).toBe('refused');
    expect(next.output).not.toContain('outside needle');
  });

  it('cannot revive an outside write after mode removal and re-enable during Ask', async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const h = await host(async () => { enter(); await held; return 'once'; });
    h.state.full = true;
    const target = path.join(h.outside, 'pending.txt');
    const pending = h.tools.run('write_file', { path: target, content: 'stale' });
    expect(await Promise.race([entered.then(() => 'asked'), pending])).toBe('asked');
    h.state.full = false; h.state.revision++;
    h.state.full = true; h.state.revision++;
    release();
    expect((await pending).status).not.toBe('success');
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await h.tools.run('write_file', { path: target, content: 'new call' })).status).toBe('success');
  });

  it('rechecks Full access before returning file bytes after a read', async () => {
    const h = await host();
    h.state.full = true;
    h.tools.setFullFileAccess(() => h.state.full);
    const target = path.join(h.outside, 'private.txt');
    await fs.writeFile(target, 'public regression fixture');
    const writes = FileWritePolicy.unhosted().forAgent({ agentId: 'dev' });
    const note = writes.noteRead.bind(writes);
    vi.spyOn(writes, 'noteRead').mockImplementation((file, snapshot) => {
      note(file, snapshot); h.state.full = false; h.state.revision++;
    });
    h.tools.setFileWrites(writes);
    const result = await h.tools.run('read_file', { path: target });
    expect(result.status).toBe('refused');
    expect(result.output).not.toContain('public regression fixture');
  });

  it('retains trust checks and dangerous folder-delete approval outside the workspace', async () => {
    const h = await host();
    h.state.full = true; h.state.trusted = false;
    const target = path.join(h.outside, 'untrusted.txt');
    await fs.writeFile(path.join(h.outside, 'read.txt'), 'outside read');
    expect((await h.tools.run('read_file', { path: path.join(h.outside, 'read.txt') })).status).toBe('refused');
    expect((await h.tools.run('write_file', { path: target, content: 'no' })).status).toBe('refused');
    h.state.trusted = true;
    const folder = path.join(h.outside, 'personal-folder');
    await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'personal.txt'), 'keep');
    let decisions = 0;
    h.tools.setFileWrites(new FileWritePolicy({ workspaceId: () => 'w', gitPath: async () => ({ repository: false }) })
      .forAgent({ agentId: 'dev', decide: async () => { decisions++; return 'deny'; } }));
    expect((await h.tools.run('delete_dir', { path: folder })).status).toBe('refused');
    expect(decisions).toBe(1);
    expect(await fs.readFile(path.join(folder, 'personal.txt'), 'utf8')).toBe('keep');
  });

  it('deletes its own outside files and folders while preserving the physical volume root', async () => {
    const h = await host(); h.state.full = true;
    const file = path.join(h.outside, 'owned.txt');
    expect((await h.tools.run('write_file', { path: file, content: 'owned' })).status).toBe('success');
    expect((await h.tools.run('delete_file', { path: file })).status).toBe('success');
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    const folder = path.join(h.outside, 'owned-folder');
    expect((await h.tools.run('write_file', { path: path.join(folder, 'owned.txt'), content: 'owned' })).status).toBe('success');
    expect((await h.tools.run('delete_dir', { path: folder })).status).toBe('success');
    await expect(fs.stat(folder)).rejects.toMatchObject({ code: 'ENOENT' });
    // This sensor makes a missing root guard fail before planning, enumerating or removing anything.
    const preview = vi.spyOn(h.tools as any, 'directoryDeletePreview').mockRejectedValue(new Error('root guard did not stop planning'));
    const root = fullAccessTargetRoot(await fs.realpath(h.outside));
    const denied = await h.tools.run('delete_dir', { path: `${root}.` });
    expect(denied.status).not.toBe('success');
    expect(denied.output).toContain('protected workspace paths');
    expect(preview).not.toHaveBeenCalled();
  });

  it('removes an outside directory link under Full access and records only the removed entry', async () => {
    let ordinaryAsks = 0;
    const h = await directoryLinkHost(undefined, async () => { ordinaryAsks++; return 'once'; });
    const owned = path.join(h.target, 'owned.txt');
    expect((await h.tools.run('write_file', { path: owned, content: 'keep owned evidence' })).status).toBe('success');
    h.effects.splice(0); ordinaryAsks = 0;
    const recorded = vi.spyOn((h.tools as any).coordinator, 'recordWrite');
    const result = await h.tools.run('delete_dir', { path: h.link });
    expect(result.status).toBe('success');
    expect(result.output).toContain('Removed directory link');
    expect(result.output).toContain('target directory and contents were not deleted');
    expect(h.decisions).toHaveLength(1); expect(ordinaryAsks).toBe(0);
    expect(h.decisions[0].before).toContain('Only this link will be removed');
    await expect(fs.lstat(h.link)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(h.target, 'personal.txt'), 'utf8')).toBe('keep personal data');
    expect(await fs.readFile(owned, 'utf8')).toBe('keep owned evidence');
    const removedName = path.join(await fs.realpath(path.dirname(h.link)), path.basename(h.link));
    expect(h.effects).toEqual([expect.objectContaining({ key: h.writes.key(removedName), operation: 'delete-file', grade: 'host-verified' })]);
    expect(recorded).toHaveBeenCalledWith('dev', removedName, '');
    expect(recorded).not.toHaveBeenCalledWith('dev', await fs.realpath(h.target), '');
    expect((await h.writes.evaluate(owned, (await h.writes.observe(owned)).state, owned)).verdict).toBe('proceed');
    const point = h.checkpoints.list().find((record) => record.operation === 'delete-directory')!;
    expect(point.target).toBe(removedName);
    expect(point.operation).toBe('delete-directory');
    expect(point.restoreDisabledReason).toBe('deleted-directory');
  });

  it('declining an outside directory-link delete keeps both the link and target with one decision', async () => {
    const h = await directoryLinkHost(async () => 'deny', async () => { throw new Error('must not ask twice'); });
    const result = await h.tools.run('delete_dir', { path: h.link });
    expect(result).toMatchObject({ status: 'refused', reason: 'consent' });
    expect(h.decisions).toHaveLength(1); expect(h.effects).toEqual([]);
    expect((await fs.lstat(h.link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(h.target, 'personal.txt'), 'utf8')).toBe('keep personal data');
  });

  it('a target file changed during Ask does not invalidate a decision to remove only its directory link', async () => {
    let ordinaryAsks = 0;
    let target = '';
    const h = await directoryLinkHost(async () => {
      await fs.writeFile(path.join(target, 'personal.txt'), 'updated while waiting; keep this data');
      return 'once';
    }, async () => { ordinaryAsks++; return 'once'; });
    target = h.target;
    const result = await h.tools.run('delete_dir', { path: h.link });
    expect(result.status).toBe('success');
    expect(result.output).toContain('Removed directory link');
    expect(h.decisions).toHaveLength(1); expect(ordinaryAsks).toBe(0);
    await expect(fs.lstat(h.link)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(h.target, 'personal.txt'), 'utf8')).toBe('updated while waiting; keep this data');
  });

  it('rejects a replaced directory-link entry after Ask even when it leads to the same target', async () => {
    const h = await directoryLinkHost();
    const original = `${h.link}-original`;
    h.writes.decide = async () => {
      await fs.rename(h.link, original);
      await fs.symlink(h.target, h.link, process.platform === 'win32' ? 'junction' : 'dir');
      return 'once';
    };
    const result = await h.tools.run('delete_dir', { path: h.link });
    expect(result.status).not.toBe('success');
    expect(result.output).toContain('directory link changed');
    expect((await fs.lstat(h.link)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(original)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(h.target, 'personal.txt'), 'utf8')).toBe('keep personal data');
    expect(h.effects).toEqual([]);
  });

  it('a link recreated during removal readback is unknown and never records its target as gone', async () => {
    const h = await directoryLinkHost();
    const removedName = path.join(await fs.realpath(path.dirname(h.link)), path.basename(h.link));
    const observe = h.writes.observe.bind(h.writes);
    let recreated = false;
    vi.spyOn(h.writes, 'observe').mockImplementation(async (physical) => {
      if (h.writes.key(physical) === h.writes.key(removedName) && !recreated) {
        await fs.symlink(h.target, h.link, process.platform === 'win32' ? 'junction' : 'dir');
        recreated = true;
      }
      return observe(physical);
    });
    const gone = vi.spyOn(h.writes, 'noteGone');
    const result = await h.tools.run('delete_dir', { path: h.link });
    expect(result.status).toBe('failed'); expect(recreated).toBe(true);
    expect(gone).not.toHaveBeenCalled();
    expect(h.effects).toEqual([expect.objectContaining({ key: h.writes.key(removedName), operation: 'delete-file', grade: 'effect-uncertain' })]);
    expect((await fs.lstat(h.link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(h.target, 'personal.txt'), 'utf8')).toBe('keep personal data');
  });

  it('Full access does not authorize a link name outside the current task even when its target is inside', async () => {
    const h = await directoryLinkHost();
    h.tools.setTurnWorkspaceAccess({ pathBase: h.root, readRoots: [h.root], writeRoots: [h.root] });
    const result = await h.tools.run('delete_dir', { path: h.link });
    expect(result).toMatchObject({ status: 'refused', reason: 'scope' });
    expect(h.decisions).toEqual([]); expect(h.effects).toEqual([]);
    expect((await fs.lstat(h.link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(h.target, 'personal.txt'), 'utf8')).toBe('keep personal data');
  });

  it('mode removal and re-enable cannot revive a link delete whose referent has permanent workspace authority', async () => {
    const h = await directoryLinkHost();
    h.writes.decide = async () => {
      h.state.full = false; h.state.revision++; h.state.full = true; h.state.revision++;
      return 'once';
    };
    const result = await h.tools.run('delete_dir', { path: h.link });
    expect(result.status).not.toBe('success');
    expect(result.output).toContain('File access for the directory link is no longer current');
    expect((await fs.lstat(h.link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(h.target, 'personal.txt'), 'utf8')).toBe('keep personal data');
    expect(h.effects).toEqual([]);
  });

  it('revoking and regranting the link parent cannot revive an old directory-link deletion', async () => {
    const h = await directoryLinkHost(); h.state.full = false;
    const owner = new SessionLocalReadScopeConsent(async () => false);
    const request = { requestId: 'r1', isCurrent: () => true };
    const old = await owner.requestPathAccess(h.outside, request, async () => ({ permission: 'readwrite', lifetime: 'request' }));
    h.tools.setLivePathAccess(() => owner.pathAccessFor('r1'));
    h.writes.decide = async () => {
      owner.revokePathAccess(old!.id);
      await owner.requestPathAccess(h.outside, request, async () => ({ permission: 'readwrite', lifetime: 'session' }));
      return 'once';
    };
    const result = await h.tools.run('delete_dir', { path: h.link });
    expect(result.status).not.toBe('success');
    expect(result.output).toContain('File access for the directory link is no longer current');
    expect((await fs.lstat(h.link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(h.target, 'personal.txt'), 'utf8')).toBe('keep personal data');
    expect(h.effects).toEqual([]);
  });

  it('writes outside documents and original attachment bytes through the real stores without granting other assets', async () => {
    const h = await saveHost();
    const outside = await temporaryFolder('unode-full-assets-');
    const sources = await admitUserTurn(h.assets, [attachment('image.png', 'image/png', 'image', PNG)]);
    const tools = h.tools('dev', sources);
    tools.setFullFileAccess(() => true);
    const image = path.join(outside, 'image.png');
    expect((await tools.run('save_attachment', { asset_id: attachmentIds(sources)[0], path: image })).status).toBe('success');
    expect(await fs.readFile(image)).toEqual(PNG);
    const stranger = h.tools('other'); stranger.setFullFileAccess(() => true);
    expect((await stranger.run('save_attachment', { asset_id: attachmentIds(sources)[0], path: path.join(outside, 'other.png') })).status).toBe('refused');
    tools.setDocumentRenderer({ render: async (request) => {
      const yazl = require('yazl') as { ZipFile: new () => DocumentZip };
      return renderDocx(request, () => new yazl.ZipFile());
    } });
    const document = path.join(outside, 'report.docx');
    const result = await tools.run('write_document', { schema_version: 1, path: document, format: 'docx', template: 'contract-v1',
      document: { title: 'Outside report', language: 'en', blocks: [{ type: 'paragraph', content: [{ text: 'Complete report.' }] }] } });
    expect(result).toMatchObject({ status: 'success', documentWrite: { code: 'written' } });
    expect((await fs.readFile(document)).subarray(0, 2).toString()).toBe('PK');
  });
});
