import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceTools } from '../WorkspaceTools';
import { exactFileGrantState, resolveEffectiveRoots } from '../folderAccess';
import { normalizeAgentReadRoots } from '../readRoots';
import { OrchestrationHostAdapter, type CoordinatorRuntimePort, type OrchestrationEvidencePort } from '../../host/orchestration/OrchestrationHostAdapter';
import { agentConfig, navigationHost } from '../../views/__tests__/support/fileNavigationHost';

const spelling = vi.hoisted(() => ({ alias: '', physical: '' }));
// Windows' legacy sync API can retain an 8.3 spelling while native/async realpath expands it.
// Model that distinction on every platform; files, links, stats and effects below are real.
async function withLegacySpelling(original: typeof import('node:fs')) {
  const legacy = ((candidate: string, options?: unknown) => {
    const result = original.realpathSync(candidate, options as never);
    if (typeof result === 'string' && spelling.alias
      && (candidate === spelling.alias || candidate.startsWith(spelling.alias + path.sep))) {
      return path.join(spelling.alias, path.relative(spelling.physical, result));
    }
    return result;
  }) as typeof original.realpathSync;
  legacy.native = original.realpathSync.native;
  return { ...original, realpathSync: legacy };
}
vi.mock('fs', async original => withLegacySpelling(await original<typeof import('node:fs')>()));
vi.mock('node:fs', async original => withLegacySpelling(await original<typeof import('node:fs')>()));

const folders: string[] = [];
afterEach(async () => {
  spelling.alias = ''; spelling.physical = '';
  await Promise.all(folders.splice(0).map(folder => fs.rm(folder, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-canonical-identity-')));
  folders.push(root);
  const physical = path.join(root, 'actual'), alias = path.join(root, 'configured-spelling'), outside = path.join(root, 'outside');
  await fs.mkdir(physical); await fs.mkdir(outside);
  await fs.symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  spelling.alias = alias; spelling.physical = physical;
  expect(realpathSync(alias)).toBe(alias);
  expect(realpathSync.native(alias)).toBe(physical);
  return { root, physical, alias, outside };
}

describe('physical identity across legacy and native path spellings', () => {
  it('admits configured and fallback roots by the physical folder and excludes the primary read root', async () => {
    const h = await fixture();
    const fallback = resolveEffectiveRoots({ fallbackPrimaryRoot: h.alias, fallbackReadRoots: [],
      workspaceRoots: [h.alias], isTrusted: true, grants: undefined });
    expect(fallback).toMatchObject({ primaryRoot: h.physical, readRoots: [h.physical], writeRoots: [h.physical] });
    const granted = resolveEffectiveRoots({ fallbackPrimaryRoot: h.outside, fallbackReadRoots: [],
      workspaceRoots: [h.alias], isTrusted: false, grants: [{ path: h.alias, permission: 'readwrite' }] });
    expect(granted.issues).toEqual([]);
    expect(granted.readRoots).toEqual([h.physical]);
    const readOnly = resolveEffectiveRoots({ fallbackPrimaryRoot: h.outside, fallbackReadRoots: [h.alias],
      workspaceRoots: [h.outside], isTrusted: true, grants: undefined });
    expect(readOnly.readRoots).toContain(h.physical);
    expect(readOnly.readRoots).not.toContain(h.alias);
    expect(readOnly.writeRoots).toEqual([h.outside]);
    expect(normalizeAgentReadRoots(h.alias, [h.physical], [h.outside], true)).toEqual([h.outside]);
    expect(normalizeAgentReadRoots(h.alias, [h.physical], [h.outside], false)).toEqual([]);
  });

  it('keeps an exact file and its parent physical through deletion, without following a retargeted grant', async () => {
    const h = await fixture(), file = path.join(h.alias, 'one.txt');
    await fs.writeFile(file, 'one');
    const access = resolveEffectiveRoots({ fallbackPrimaryRoot: h.outside, fallbackReadRoots: [],
      workspaceRoots: [h.alias], isTrusted: true, grants: [{ path: file, permission: 'readwrite' }] });
    const grant = access.writeFiles[0];
    expect(grant).toMatchObject({ lexicalPath: file, realPath: path.join(h.physical, 'one.txt'), realParent: h.physical });
    expect(access.writeRoots).toEqual([]);
    expect(exactFileGrantState(grant)).toBe('present');
    await fs.unlink(file);
    expect(exactFileGrantState(grant)).toBe('absent');
    await fs.unlink(h.alias);
    await fs.symlink(h.outside, h.alias, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(path.join(h.outside, 'one.txt'), 'other');
    expect(exactFileGrantState(grant)).toBe('changed');
  });

  it('runs the real host read/write/delete store through an alias and refuses an outside link name', async () => {
    const h = await fixture();
    const tools = new WorkspaceTools(h.alias, new Set(['read', 'write']));
    expect((await tools.run('write_file', { path: 'inside.txt', content: 'kept source' })).status).toBe('success');
    expect((await tools.run('read_file', { path: 'inside.txt' })).output).toBe('kept source');
    const outsideName = path.join(h.outside, 'link-to-inside');
    await fs.symlink(h.physical, outsideName, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await tools.run('delete_dir', { path: outsideName })).toMatchObject({ status: 'refused', reason: 'scope' });
    expect((await fs.lstat(outsideName)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(h.physical, 'inside.txt'), 'utf8')).toBe('kept source');
    expect((await tools.run('delete_file', { path: 'inside.txt' })).status).toBe('success');
    await expect(fs.stat(path.join(h.physical, 'inside.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('intersects a task with configured physical authority and reports an in-workspace scope refusal', async () => {
    const h = await fixture();
    await fs.mkdir(path.join(h.physical, 'task'));
    await fs.writeFile(path.join(h.physical, 'outside-task.txt'), 'outside task');
    const tools = new WorkspaceTools(h.alias, new Set(['read', 'write']));
    expect(tools.setContractTaskScope({ folderAccess: [{ path: 'task', permission: 'readwrite' }] })).toBe(true);
    expect((await tools.run('write_file', { path: 'task/inside.txt', content: 'inside task' })).status).toBe('success');
    expect((await tools.run('read_file', { path: 'task/inside.txt' })).output).toBe('inside task');
    expect(await tools.run('read_file', { path: 'outside-task.txt' })).toMatchObject({ status: 'refused', reason: 'task-scope' });
    expect(await tools.run('read_file', { path: path.join(h.physical, 'outside-task.txt') }))
      .toMatchObject({ status: 'refused', reason: 'task-scope' });
    expect(await tools.run('write_file', { path: 'outside-task.txt', content: 'must stay unchanged' }))
      .toMatchObject({ status: 'refused', reason: 'task-scope' });
    expect(await tools.run('write_file', { path: path.join(h.physical, 'outside-task.txt'), content: 'must stay unchanged' }))
      .toMatchObject({ status: 'refused', reason: 'task-scope' });
    expect(await fs.readFile(path.join(h.physical, 'outside-task.txt'), 'utf8')).toBe('outside task');
  });

  it('opens recorded and reply files by physical identity without moving a historical ceiling', async () => {
    const h = await fixture(), physicalFile = path.join(h.physical, 'one.txt'), aliasFile = path.join(h.alias, 'one.txt');
    await fs.writeFile(physicalFile, 'one');
    const config = agentConfig('worker', { backend: 'openai-compat', workingDirectory: h.alias });
    const host = navigationHost([h.alias], [config]);
    const ceilings = host.adapter.fileLinkCeilings(config.id);
    expect(ceilings).toEqual([h.physical]);
    await host.adapter.openRecordedWorkspaceFile(config.id, aliasFile);
    await host.adapter.openFileReference(config.id, { destination: aliasFile, roots: [h.alias], ceilings, stillShown: () => true });
    expect(host.notices).toEqual([]);
    expect(host.opened.map(file => file.path)).toEqual([physicalFile, physicalFile]);
    await fs.unlink(h.alias);
    await fs.symlink(h.outside, h.alias, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(path.join(h.outside, 'one.txt'), 'outside');
    await host.adapter.openFileReference(config.id, { destination: aliasFile, roots: [h.alias], ceilings, stillShown: () => true });
    expect(host.opened).toHaveLength(2);
    expect(host.notices).toHaveLength(1);
  });

  it('admits a task through the actual host adapter with only its physical directory', async () => {
    const h = await fixture(), task = path.join(h.physical, 'task');
    await fs.mkdir(task);
    const config = agentConfig('worker', { backend: 'openai-compat', workingDirectory: h.alias });
    const runtime: Partial<CoordinatorRuntimePort> = {
      workspace: () => ({ root: () => h.alias, roots: () => [h.alias], additionalReadRoots: () => [], isTrusted: () => true }),
      fullFileAccess: () => false, taskScopeActive: () => false,
      backendKindFor: () => 'openai-compat', configForAgent: () => config,
    };
    const adapter = new OrchestrationHostAdapter(runtime as CoordinatorRuntimePort, {} as OrchestrationEvidencePort);
    const admitted = adapter.resolveTaskWorkspaceAccess(config, {
      folderAccess: [{ path: path.join(h.alias, 'task'), permission: 'readwrite' }],
    });
    expect(admitted.reason).toBeUndefined();
    expect(admitted.access).toMatchObject({ readRoots: [task], writeRoots: [task], commandCwd: task });
    expect(admitted.access!.writeRoots).not.toContain(h.physical);
  });
});
