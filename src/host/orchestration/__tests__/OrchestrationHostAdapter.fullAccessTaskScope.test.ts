import { mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asProvider } from '../../../backend/__tests__/shellFixtures';
import { WorkspaceTools } from '../../../backend/WorkspaceTools';
import { CommandPolicy } from '../../../backend/CommandPolicy';
import { OrchestrationHostAdapter, type CoordinatorRuntimePort, type OrchestrationEvidencePort } from '../OrchestrationHostAdapter';
import { agentConfig, tempFolder } from '../../../views/__tests__/support/fileNavigationHost';
import type { SessionPathAccessGrant } from '../../../backend/localReadScope';
import { compileTaskContract } from '../../../backend/TaskContract';
import type { AgentConfig, DelegationTaskScope } from '../../../types';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function folder(files: Record<string, string> = {}) {
  const made = tempFolder(files, 'unode-full-task-admission-');
  cleanups.push(made.cleanup);
  return realpathSync.native(made.root);
}

function host() {
  const irrelevant = [folder(), folder(), folder()];
  const root = folder({ 'workspace.md': 'workspace' });
  const outside = folder({ 'allowed.md': 'outside allowed', 'sibling.md': 'outside sibling' });
  const config = agentConfig('worker', { backend: 'openai-compat', workingDirectory: root });
  const state = { full: true, trusted: true, task: true, revision: 0, commands: 0 };
  const grants: { list: SessionPathAccessGrant[] } = { list: [] };
  const runtime: Partial<CoordinatorRuntimePort> = {
    workspace: () => ({ root: () => root, roots: () => [...irrelevant, root], additionalReadRoots: () => [],
      isTrusted: () => state.trusted }),
    fullFileAccess: () => state.full,
    taskScopeActive: () => state.task,
    backendKindFor: (agent) => agent.backend ?? 'openai-compat',
    configForAgent: () => config,
    pathGrantsFor: (requestId) => grants.list.filter((grant) => grant.lifetime === 'session' || grant.requestId === requestId),
    currentRequestId: (agentId) => (agentId === 'pm' ? 'dispatching-request' : undefined),
  };
  const adapter = new OrchestrationHostAdapter(runtime as CoordinatorRuntimePort, {} as OrchestrationEvidencePort);
  const scope = (target: string, permission: 'read' | 'readwrite' = 'readwrite'): DelegationTaskScope => ({ folderAccess: [{ path: target, permission }] });
  const tools = () => {
    const tool = new WorkspaceTools(root, new Set(['read', 'write', 'execute']), config.id, undefined,
      new CommandPolicy('all'), undefined, undefined, undefined, undefined,
      asProvider(async () => { state.commands++; return { code: 0, output: 'fake executor' }; }));
    tool.setFullFileAccess(() => state.full, () => state.revision);
    return tool;
  };
  return { root, outside, config, state, grants, adapter, scope, tools };
}

// v0.9.100 (the Owner, S7): a contract may name an outside path. What the teammate can already reach decides, and the
// person is told. Naming a path grants nothing.
describe('a task contract that names a path outside the workspace', () => {
  const contract = (root: string, outside: string) => compileTaskContract({
    version: 1, objective: 'Work on the outside folder.', expected_deliverable: 'A result.',
    effects: { read_files: [path.join(outside, 'allowed.md')], write_scope: { folder_access: [{ path: outside, permission: 'readwrite' }] }, expected_file_effect: 'modify' },
    inputs: [], constraints: [], dependencies: [], required_capabilities: { version: 1, capabilities: ['read', 'write'] },
    execution_strategy: 'delegate-required',
  }, 'pm', root);

  it('compiles, and keeps the absolute path', () => {
    const h = host();
    const compiled = contract(h.root, h.outside);
    expect(compiled.error).toBeUndefined();
    expect(compiled.contract?.effects.writeScope?.folderAccess).toEqual([{ path: h.outside, permission: 'readwrite' }]);
    expect(compiled.contract?.effects.readFiles).toEqual([path.join(h.outside, 'allowed.md')]);
  });

  it('a relative path out of the workspace stays refused', () => {
    const h = host();
    const compiled = compileTaskContract({
      version: 1, objective: 'Work.', expected_deliverable: 'A result.',
      effects: { read_files: ['../other/file.md'], expected_file_effect: 'none' },
      inputs: [], constraints: [], dependencies: [], required_capabilities: { version: 1, capabilities: ['read'] },
      execution_strategy: 'delegate-required',
    }, 'pm', h.root);
    expect(compiled.error).toContain('or an absolute path');
  });

  // v0.9.101 (H1, the Owner 2026-11-07): with no grant the task is no longer refused. It is admitted with the folder it
  // needs pending: no authority over it, offered for Grant access, and reached by a grant made while it runs.
  it('is admitted for an agent on Full access and through a session grant, and with no grant holds the folder only as a pending need', () => {
    const h = host();
    expect(h.adapter.resolveTaskWorkspaceAccess(h.config, h.scope(h.outside)).reason).toBeUndefined();
    h.state.full = false;
    const waiting = h.adapter.resolveTaskWorkspaceAccess(h.config, h.scope(h.outside));
    expect(waiting.reason).toBeUndefined();
    expect(waiting.access).toMatchObject({ readRoots: [], writeRoots: [], readFiles: [], writeFiles: [],
      pending: { readRoots: [h.outside], writeRoots: [h.outside] } });
    expect(waiting.outOfReach).toEqual([h.outside]);
    h.grants.list = [{ id: 'g', permission: 'read', lifetime: 'session', current: () => true,
      target: { kind: 'directory', permission: 'read', lexicalPath: h.outside, realPath: h.outside, realParent: path.dirname(h.outside) } }];
    const read = h.adapter.resolveTaskWorkspaceAccess(h.config, h.scope(h.outside));
    expect(read.access).toMatchObject({ readRoots: [h.outside], writeRoots: [], pending: { readRoots: [], writeRoots: [h.outside] } });
  });

  // Audit of 35f593f8 (I4): a shorter, deliberately chosen grant must not be turned away and a longer one asked for.
  it('a request grant admits a task of that request and of no other', () => {
    const h = host();
    h.state.full = false;
    h.grants.list = [{ id: 'g', permission: 'read', lifetime: 'request', requestId: 'r1', current: () => true,
      target: { kind: 'file', permission: 'read', lexicalPath: path.join(h.outside, 'allowed.md'), realPath: path.join(h.outside, 'allowed.md'), realParent: h.outside } }];
    const scope = h.scope(path.join(h.outside, 'allowed.md'), 'read');
    const file = path.join(h.outside, 'allowed.md');
    const held = (requestId: string | undefined) => h.adapter.resolveTaskWorkspaceAccess(h.config, scope, requestId).access;
    expect(held('r1')?.readFiles?.map((granted) => granted.realPath)).toEqual([file]);
    expect(held('r1')?.pending).toBeUndefined();
    // v0.9.101 (H1): another request's task is admitted with the file only pending: it holds none of r1's grant.
    for (const other of ['r2', undefined]) {
      expect(held(other)?.readFiles).toEqual([]);
      expect(held(other)?.pending?.readFiles.map((pending) => pending.realPath)).toEqual([file]);
    }
    // Revoked: the next admission loses it.
    h.grants.list = [];
    expect(held('r1')?.readFiles).toEqual([]);
    expect(held('r1')?.pending?.readFiles.map((pending) => pending.realPath)).toEqual([file]);
  });

  it('the dispatch preflight and the worker\'s delivery name the task\'s request', () => {
    const h = host();
    h.state.full = false;
    h.grants.list = [{ id: 'g', permission: 'read', lifetime: 'request', requestId: 'dispatching-request', current: () => true,
      target: { kind: 'directory', permission: 'read', lexicalPath: h.outside, realPath: h.outside, realParent: path.dirname(h.outside) } }];
    const view = h.adapter.makeTeamView();
    expect(view.preflightTaskScope?.('worker', h.scope(h.outside, 'read'), 'pm')).toBeUndefined();
    expect(view.taskScopeShortfall?.('worker', h.scope(h.outside, 'read'), 'pm')).toEqual([]);
    // v0.9.101 (H1): another request's grant does not count. The dispatch is admitted, and what it lacks is named.
    h.grants.list[0] = { ...h.grants.list[0], requestId: 'another-request' };
    expect(view.preflightTaskScope?.('worker', h.scope(h.outside, 'read'), 'pm')).toBeUndefined();
    expect(view.taskScopeShortfall?.('worker', h.scope(h.outside, 'read'), 'pm')).toEqual([h.outside]);
    expect(readFileSync('src/extension.ts', 'utf8')).toContain('orchestrationHost.resolveTaskWorkspaceAccess(config, msg.payload.taskScope, requestId)');
    expect(readFileSync('src/extension.ts', 'utf8')).toContain('pathGrantsFor: (requestId) => localReadScopeConsent.pathAccessFor(requestId),');
    expect(readFileSync('src/backend/TeamTools.ts', 'utf8')).toContain('this.view.preflightTaskScope(entry.id, judgedScope, this.selfId)');
  });

  it('tells the person what the task can reach, and says nothing for a task inside the workspace', () => {
    const h = host();
    const notice = (h.adapter as unknown as { outsideScopeNotice(event: unknown): string | undefined });
    const compiled = contract(h.root, h.outside);
    const text = notice.outsideScopeNotice({ agentId: 'worker', contract: compiled.contract })!;
    expect(text).toContain(`${h.outside} (Read + Write)`);
    expect(text).toContain('this task only');
    expect(notice.outsideScopeNotice({ agentId: 'worker', scope: { folderAccess: [{ path: 'docs', permission: 'read' }] } })).toBeUndefined();
    expect(notice.outsideScopeNotice({ agentId: 'worker', scope: { folderAccess: [{ path: h.root, permission: 'read' }] } })).toBeUndefined();
  });

  // Audit of 35f593f8 (M1): the notice described the declaration, not what was admitted.
  it('names the admitted permission, not the requested one', () => {
    const h = host();
    h.state.full = false;
    const file = path.join(h.outside, 'allowed.md');
    h.grants.list = [{ id: 'g', permission: 'read', lifetime: 'session', current: () => true,
      target: { kind: 'file', permission: 'read', lexicalPath: file, realPath: file, realParent: h.outside } }];
    const notice = (h.adapter as unknown as { outsideScopeNotice(event: unknown): string | undefined });
    const text = notice.outsideScopeNotice({ agentId: 'worker', coordinatorId: 'pm', scope: { folderAccess: [{ path: file, permission: 'readwrite' }] } })!;
    expect(text).toContain(`${file} (Read)`);
    expect(text).not.toContain('Read + Write');
    // A grant for the dispatching request counts; one for another request does not.
    const forRequest = { id: 'r', permission: 'read', lifetime: 'request', current: () => true,
      target: { kind: 'file', permission: 'read', lexicalPath: file, realPath: file, realParent: h.outside } } as const;
    h.grants.list = [{ ...forRequest, requestId: 'dispatching-request' }];
    expect(notice.outsideScopeNotice({ agentId: 'worker', coordinatorId: 'pm', scope: { folderAccess: [{ path: file, permission: 'read' }] } })).toContain(`${file} (Read)`);
    h.grants.list = [{ ...forRequest, requestId: 'another-request' }];
    expect(notice.outsideScopeNotice({ agentId: 'worker', coordinatorId: 'pm', scope: { folderAccess: [{ path: file, permission: 'read' }] } })).toBeUndefined();
    // Nothing admitted, nothing announced.
    h.grants.list = [];
    expect(notice.outsideScopeNotice({ agentId: 'worker', scope: { folderAccess: [{ path: file, permission: 'readwrite' }] } })).toBeUndefined();
  });

  // Field, 4c06a304 S7c: Activity said read/write. The person allowed Read, and that is all the task can do.
  it('Activity shows the admitted permission and physical path, and the worker\'s tools hold to them', async () => {
    const h = host();
    h.state.full = false;
    const file = path.join(h.outside, 'allowed.md');
    h.grants.list = [{ id: 'g', permission: 'read', lifetime: 'request', requestId: 'dispatching-request', current: () => true,
      target: { kind: 'file', permission: 'read', lexicalPath: file, realPath: file, realParent: h.outside } }];
    const text = (h.adapter as unknown as { admittedScopeText(event: unknown): string | undefined });
    const scope = h.scope(file, 'readwrite');
    expect(text.admittedScopeText({ agentId: 'worker', coordinatorId: 'pm', scope })).toBe(`read-only ${file}`);
    const admitted = h.adapter.resolveTaskWorkspaceAccess(h.config, scope, 'dispatching-request').access;
    expect(admitted).toMatchObject({ readFiles: [expect.objectContaining({ realPath: file })], writeFiles: [], writeRoots: [] });
    const tools = h.tools();
    tools.setTurnWorkspaceAccess(admitted);
    expect((await tools.run('write_file', { path: file, content: 'no' })).status).toBe('refused');
    expect(readFileSync(file, 'utf8')).toBe('outside allowed');

    // Field, 4c06a304 S7d: a link is named by where it leads. Nothing admitted leaves the requested text in place.
    h.state.full = true;
    h.grants.list = [];
    symlinkSync(h.outside, path.join(h.root, 'link-out'), 'junction');
    expect(text.admittedScopeText({ agentId: 'worker', coordinatorId: 'pm', scope: { folderAccess: [{ path: 'link-out', permission: 'readwrite' }] } }))
      .toBe(`read/write ${h.outside}`);
    h.state.full = false;
    expect(text.admittedScopeText({ agentId: 'worker', coordinatorId: 'pm', scope })).toBeUndefined();
    expect(text.admittedScopeText({ agentId: 'worker', coordinatorId: 'pm' })).toBeUndefined();
  });

  // Field, 4c06a304 T2: the refusal told the person to choose Grant access, with nothing on screen to choose for the
  // folder the task was to write in.
  it('a dispatch refused for its scope offers the grant for each outside target, and never one inside the workspace', () => {
    const h = host();
    h.state.full = false;
    const offers: Array<[string, string]> = [];
    (h.adapter as unknown as { runtime: CoordinatorRuntimePort }).runtime.offerPathAccess = (agentId, target) => { offers.push([agentId, target]); };
    const file = path.join(h.outside, 'allowed.md');
    const view = h.adapter.makeTeamView();
    // Preflight alone offers nothing: it is asked of every candidate, and another may take the task. v0.9.101 (H1): it
    // no longer refuses a scope a grant could open.
    expect(view.preflightTaskScope?.('worker', h.scope(h.outside), 'pm')).toBeUndefined();
    expect(offers).toEqual([]);
    const sibling = path.join(h.outside, 'sibling.md');
    view.offerTaskScopeAccess?.('worker', { folderAccess: [{ path: file, permission: 'read' }, { path: sibling, permission: 'readwrite' }] }, 'pm');
    expect(offers).toHaveLength(2);
    expect(offers).toEqual(expect.arrayContaining([['pm', file], ['pm', sibling]]));
    // Something the worker can reach: the task is admitted, narrowed. Since v0.9.100 (field, 7fc21c4b T2) the outside
    // part it cannot reach is still offered; the part inside the workspace never is.
    offers.length = 0;
    view.offerTaskScopeAccess?.('worker', { folderAccess: [{ path: file, permission: 'read' }, { path: h.root, permission: 'read' }] }, 'pm');
    expect(offers).toEqual([['pm', file]]);
    expect(view.taskScopeShortfall?.('worker', { folderAccess: [{ path: file, permission: 'read' }, { path: h.root, permission: 'read' }] }, 'pm'))
      .toEqual([file]);

    // An agent's own Folder Access is a ceiling a grant does not widen: no offer it could not keep.
    offers.length = 0;
    (h.adapter as unknown as { runtime: CoordinatorRuntimePort }).runtime.configForAgent = () => ({ ...h.config, folderAccess: [{ path: h.root, permission: 'read' }] });
    view.offerTaskScopeAccess?.('worker', h.scope(h.outside), 'pm');
    expect(offers).toEqual([]);
  });

  it('names an outside folder reached through a relative link, by its physical path', () => {
    const h = host();
    const link = path.join(h.root, 'link');
    symlinkSync(h.outside, link, 'junction');
    const notice = (h.adapter as unknown as { outsideScopeNotice(event: unknown): string | undefined });
    const text = notice.outsideScopeNotice({ agentId: 'worker', scope: { folderAccess: [{ path: 'link', permission: 'readwrite' }] } })!;
    expect(text).toContain(`${h.outside} (Read + Write)`);
  });

  // Audit of 9d8c5bcb (M1-R): a read file is a pointer. Under a task scope it stays out of reach, whatever Full access says.
  it('under a task scope, names no read file outside that scope, and the file tools agree', async () => {
    const h = host();
    const file = path.join(h.outside, 'allowed.md');
    const notice = (h.adapter as unknown as { outsideScopeNotice(event: unknown): string | undefined });
    const scope = h.scope(h.root, 'read');
    expect(notice.outsideScopeNotice({ agentId: 'worker', scope, contract: { effects: { readFiles: [file], writeScope: scope } } })).toBeUndefined();
    const tools = h.tools();
    tools.setTurnWorkspaceAccess(h.adapter.resolveTaskWorkspaceAccess(h.config, scope, undefined).access);
    const read = await tools.run('read_file', { path: file });
    expect(read).toMatchObject({ status: 'refused' });
  });

  it('names a read file the worker can reach, and no read file it cannot', () => {
    const h = host();
    const file = path.join(h.outside, 'allowed.md');
    const notice = (h.adapter as unknown as { outsideScopeNotice(event: unknown): string | undefined });
    const event = { agentId: 'worker', contract: { effects: { readFiles: [file] } } };
    expect(notice.outsideScopeNotice(event)).toContain(`${file} (Read)`);
    h.state.full = false;
    expect(notice.outsideScopeNotice(event)).toBeUndefined();
  });

  it('the dispatch of a task publishes that notice', () => {
    const source = readFileSync('src/host/orchestration/OrchestrationHostAdapter.ts', 'utf8');
    expect(source).toContain('const notice = this.outsideScopeNotice(event);');
  });
});

describe('Full access task admission through the real adapter', () => {
  it('admits the declared outside folder under base Full while a scoped task is active and keeps the folder ceiling', async () => {
    const h = host();
    const admitted = h.adapter.resolveTaskWorkspaceAccess(h.config, h.scope(h.outside));
    expect(admitted.reason).toBeUndefined();
    expect(admitted.access).toMatchObject({ pathBase: h.root, readRoots: [h.outside], writeRoots: [h.outside],
      commandCwd: h.outside, readFiles: [], writeFiles: [] });
    const tools = h.tools();
    tools.setTurnWorkspaceAccess(admitted.access);
    expect((await tools.run('read_file', { path: path.join(h.outside, 'allowed.md') })).output).toBe('outside allowed');
    expect((await tools.run('write_file', { path: path.join(h.outside, 'created.md'), content: 'created' })).status).toBe('success');
    expect((await tools.run('read_file', { path: path.join(h.root, 'workspace.md') })).status).toBe('refused');
    const another = folder({ 'not-in-task.md': 'not allowed by this task' });
    expect((await tools.run('read_file', { path: path.join(another, 'not-in-task.md') })).status).toBe('refused');
  });

  it('keeps an outside exact-file request exact with no command directory or writable sibling', async () => {
    const h = host();
    const target = path.join(h.outside, 'allowed.md');
    const admitted = h.adapter.resolveTaskWorkspaceAccess(h.config, h.scope(target));
    expect(admitted.reason).toBeUndefined();
    expect(admitted.access).toMatchObject({ readRoots: [], writeRoots: [],
      readFiles: [expect.objectContaining({ realPath: target })], writeFiles: [expect.objectContaining({ realPath: target })] });
    expect(admitted.access).not.toHaveProperty('commandCwd');
    const tools = h.tools();
    tools.setTurnWorkspaceAccess(admitted.access);
    expect((await tools.run('write_file', { path: target, content: 'changed exact file' })).status).toBe('success');
    expect((await tools.run('read_file', { path: path.join(h.outside, 'sibling.md') })).status).toBe('refused');
    expect((await tools.run('write_file', { path: path.join(h.outside, 'sibling.md'), content: 'no' })).status).toBe('refused');
    expect((await tools.run('run_command', { command: 'echo in the agent folder' })).status).toBe('success');
    expect(h.state.commands).toBe(1);
    // A read-only exact file cannot borrow the volume introduced by its writable sibling case above.
    // It must contribute its own Full read authority before the task intersection can keep that one file.
    const readOnly = h.adapter.resolveTaskWorkspaceAccess(h.config, h.scope(target, 'read'));
    expect(readOnly.reason).toBeUndefined();
    expect(readOnly.access).toMatchObject({ readRoots: [], writeRoots: [], writeFiles: [],
      readFiles: [expect.objectContaining({ realPath: target })] });
    expect(readOnly.access).not.toHaveProperty('commandCwd');
    tools.setTurnWorkspaceAccess(readOnly.access);
    const read = await tools.run('read_file', { path: target });
    expect(read.status).toBe('success');
    expect(read.output.split('\n')[0]).toBe('changed exact file');
    expect(read.output).toContain('[read-only in your tree');
    expect((await tools.run('read_file', { path: path.join(h.outside, 'sibling.md') })).status).toBe('refused');
    expect((await tools.run('write_file', { path: target, content: 'read-only stays read-only' })).status).toBe('refused');
    expect((await tools.run('run_command', { command: 'echo in the agent folder' })).status).toBe('success');
  });

  it('does not give a read-only outside task any write authority', async () => {
    const h = host();
    const admitted = h.adapter.resolveTaskWorkspaceAccess(h.config, h.scope(h.outside, 'read'));
    expect(admitted.reason).toBeUndefined();
    expect(admitted.access).toMatchObject({ readRoots: [h.outside], writeRoots: [] });
    const tools = h.tools();
    tools.setTurnWorkspaceAccess(admitted.access);
    expect((await tools.run('read_file', { path: path.join(h.outside, 'allowed.md') })).status).toBe('success');
    expect((await tools.run('write_file', { path: path.join(h.outside, 'allowed.md'), content: 'no' })).status).toBe('refused');
  });

  it('gives the same outside task no authority in Workspace, and refuses it through an explicit Folder Access ceiling or without trust', () => {
    const h = host();
    h.state.full = false;
    // v0.9.101 (H1): in Workspace it waits for a grant, holding nothing.
    expect(h.adapter.resolveTaskWorkspaceAccess(h.config, h.scope(h.outside)).access)
      .toMatchObject({ readRoots: [], writeRoots: [], pending: { writeRoots: [h.outside] } });
    h.state.full = true;
    const confined: AgentConfig = { ...h.config, folderAccess: [{ path: h.root, permission: 'readwrite' }] };
    expect(h.adapter.resolveTaskWorkspaceAccess(confined, h.scope(h.outside))).toHaveProperty('reason');
    expect(h.adapter.resolveTaskWorkspaceAccess(confined, h.scope(h.root)).reason).toBeUndefined();
    h.state.trusted = false;
    expect(h.adapter.resolveTaskWorkspaceAccess(h.config, h.scope(h.outside))).toHaveProperty('reason');
  });

  it('admission does not freeze Full authority after revocation in the actual task file tools', async () => {
    const h = host();
    const target = path.join(h.outside, 'allowed.md');
    const admitted = h.adapter.resolveTaskWorkspaceAccess(h.config, h.scope(target));
    expect(admitted.reason).toBeUndefined();
    const tools = h.tools();
    tools.setTurnWorkspaceAccess(admitted.access);
    expect((await tools.run('read_file', { path: target })).status).toBe('success');
    h.state.full = false;
    h.state.revision++;
    expect((await tools.run('read_file', { path: target })).status).toBe('refused');
    expect((await tools.run('write_file', { path: target, content: 'must not land' })).status).toBe('refused');
  });

  it('derives admitted task targets physically through a junction while still intersecting its exact declared subtree', () => {
    const h = host();
    mkdirSync(path.join(h.outside, 'sub'));
    const alias = path.join(h.root, 'outside-alias');
    symlinkSync(h.outside, alias, 'junction');
    const physicalSubtree = realpathSync(path.join(alias, 'sub'));
    const admitted = h.adapter.resolveTaskWorkspaceAccess(h.config, h.scope(path.join(alias, 'sub')));
    expect(admitted.reason).toBeUndefined();
    expect(admitted.access).toMatchObject({ readRoots: [physicalSubtree], writeRoots: [physicalSubtree] });
    expect(admitted.access?.readRoots).not.toContain(h.root);
    expect(admitted.access?.readRoots).not.toContain(path.parse(physicalSubtree).root);
  });
});
