import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageBus } from '../../../bus/MessageBus';
import { ContentAssetStore } from '../../../content/ContentAssetStore';
import { SessionLocalReadScopeConsent } from '../../../backend/localReadScope';
import { TeamTools, type TeamRosterEntry, type TeamView } from '../../../backend/TeamTools';
import { WorkspaceTools } from '../../../backend/WorkspaceTools';
import { TaskInputResolver, type OutsideInputAccess } from '../../../backend/TaskContract';
import { OrchestrationHostAdapter, type CoordinatorRuntimePort, type OrchestrationEvidencePort } from '../OrchestrationHostAdapter';
import { agentConfig, tempFolder } from '../../../views/__tests__/support/fileNavigationHost';
import type { AgentConfig, DelegationTaskScope, Message } from '../../../types';

/*
 * v0.9.101 (A1, field aebbd520 T2): "summarise this contract, which is outside the workspace". The PM put the contract
 * in contract.inputs, which made the whole contract invalid, and then dispatched with no scope. Here the real dispatch
 * entry (TeamTools dispatch_task), the host's real admission view and resolver, the real grant store and the worker's
 * real file tools run on real temporary folders. Only the delegate is fake: it records what it was handed.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

const LEASE = 'MASTER LEASE AGREEMENT\nClause 1. The lessee leases the compute.\n';
const REQUEST = 'request-1';
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function folder(files: Record<string, string> = {}) {
  const made = tempFolder(files, 'unode-a1-');
  cleanups.push(made.cleanup);
  return realpathSync.native(made.root);
}

function host(dev: Partial<AgentConfig> = {}) {
  const root = folder({ 'notes.md': 'workspace' });
  const outside = folder({ 'lease.txt': LEASE });
  const source = path.join(outside, 'lease.txt');
  const consent = new SessionLocalReadScopeConsent(async () => false);
  const roster: TeamRosterEntry[] = [
    { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
    {
      id: 'dev', role: 'senior-dev', name: 'Dev', status: 'idle',
      capabilities: { read: true, write: true, shell: false, verificationSensors: [], toolFamilies: ['read', 'write'], backend: 'openai-compat', taskScope: 'per-turn' },
    },
  ];
  const configs: Record<string, AgentConfig> = {
    pm: agentConfig('pm', { backend: 'openai-compat', workingDirectory: root }),
    dev: agentConfig('dev', { backend: 'openai-compat', workingDirectory: root, ...dev }),
  };
  const offered: string[] = [];
  const runtime: Partial<CoordinatorRuntimePort> = {
    workspace: () => ({ root: () => root, roots: () => [root], additionalReadRoots: () => [], isTrusted: () => true }),
    teamEntries: () => roster,
    resolveTeam: (ref) => (configs[ref] ? { id: ref } : undefined),
    configForAgent: (id) => configs[id],
    fullFileAccess: () => false,
    backendKindFor: (agent) => agent.backend ?? 'openai-compat',
    pathGrantsFor: (requestId) => consent.pathAccessFor(requestId),
    currentRequestId: () => REQUEST,
    offerPathAccess: (_agentId, target) => { offered.push(target); },
  };
  const adapter = new OrchestrationHostAdapter(runtime as CoordinatorRuntimePort, {} as OrchestrationEvidencePort);
  const store = new ContentAssetStore();
  cleanups.push(() => { void store.dispose(); });
  const resolver = adapter.createTaskInputResolver(store);
  const bus = new MessageBus();
  const assigned: Message[] = [];
  bus.onType('task.assign', (message: Message) => { assigned.push(message); });
  const view = adapter.makeTeamView();
  const tools = new TeamTools('pm', view, bus, { timeoutMs: 1_000, taskInputResolver: resolver, cwd: root });
  /** The person's own choice in the real grant store, as the Grant access notice makes it. */
  const grant = (target: string, permission: 'read' | 'readwrite' = 'read') => consent.requestPathAccess(target,
    { requestId: REQUEST, isCurrent: () => true }, async () => ({ permission, lifetime: 'request' }));
  const dispatch = async (raw: Record<string, unknown>) =>
    (await tools.runOutcome('dispatch_task', { agent: 'dev', instruction: 'Summarise the lease in English and Chinese.', contract: raw })).output;
  return { root, outside, source, consent, adapter, store, view, assigned, offered, grant, dispatch, config: configs.dev };
}

/** The contract the PM wrote in the field: the outside source is a required input, and nothing else names it. */
function leaseContract(source: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    objective: 'Summarise the lease in English and Traditional Chinese.',
    expected_deliverable: 'A bilingual summary.',
    effects: { read_files: [], expected_file_effect: 'none' },
    inputs: [{
      input_id: 'lease', kind: 'workspacePath', path: source, purpose: 'The contract to summarise', required: true,
      freshness: 'dispatch-snapshot', provenance: { kind: 'user-turn', source_refs: [] },
    }],
    constraints: [],
    dependencies: [],
    required_capabilities: { version: 1, capabilities: ['read'] },
    execution_strategy: 'delegate-required',
    ...extra,
  };
}

describe('v0.9.101 A1: an outside source in contract.inputs, from dispatch_task to the worker\'s snapshot', () => {
  it('is refused precisely and offered until granted, then the same contract dispatches with the file\'s own content', async () => {
    const h = host();
    const before = sha256(readFileSync(h.source));
    const contract = leaseContract(h.source);

    // Ungranted: the contract is valid; the dispatch is refused for the missing grant, never as a missing file.
    const refused = await h.dispatch(contract);
    expect(refused).not.toMatch(/invalid task contract/i);
    expect(refused).toMatch(/grant-needed: required input "lease"/);
    expect(refused).toContain('Grant access');
    expect(refused).not.toMatch(/does not exist|not found|no regular file/i);
    expect(h.assigned).toEqual([]);
    expect(h.offered).toEqual([h.source]);

    // The person grants Read through the real grant store; the same contract, inputs and all, is dispatched again.
    expect(await h.grant(h.source)).toBeDefined();
    const dispatched = await h.dispatch(contract);
    expect(dispatched).toMatch(/^Dispatched contract contract-/);
    expect(h.assigned).toHaveLength(1);
    const attempt = h.assigned[0].payload.taskAttempt;
    expect(attempt.contract.inputs[0]).toMatchObject({ inputId: 'lease', path: h.source, required: true });
    const grant = attempt.grants.find((entry: { inputId: string }) => entry.inputId === 'lease');
    expect(grant).toMatchObject({ kind: 'workspacePath', sourceRef: h.source, agentId: 'dev' });
    // The worker's snapshot is the outside file's content, byte for byte.
    const snapshot = await h.store.readExtractedContent(grant.resolvedContentAssetId, { start: 1, end: 1 });
    const text = 'error' in snapshot ? snapshot.error : snapshot.items.map((item) => item.text).join('');
    expect(sha256(text)).toBe(before);
    // The source is unchanged, and the worker's own tools read it but cannot write it: Read never became Write.
    const worker = new WorkspaceTools(h.root, new Set(['read', 'write']), 'dev');
    worker.setLivePathAccess(() => h.consent.pathAccessFor(REQUEST));
    expect((await worker.run('read_file', { path: h.source })).output).toContain('Clause 1.');
    expect((await worker.run('write_file', { path: h.source, content: 'overwritten' })).status).toBe('refused');
    expect(sha256(readFileSync(h.source))).toBe(before);
  });

  it('under a task scope, joins it as read only, and the same scoped contract dispatches after the grant', async () => {
    const h = host();
    const out = path.join(h.root, 'out');
    const scoped = leaseContract(h.source, {
      effects: { read_files: [], write_scope: { folder_access: [{ path: 'out', permission: 'readwrite' }] }, expected_file_effect: 'create' },
      required_capabilities: { version: 1, capabilities: ['read', 'write'] },
    });
    mkdirSync(out);
    const refused = await h.dispatch(scoped);
    expect(refused).toMatch(/grant-needed: required input "lease"/);
    // The scope's own resolution never calls the ungranted source a missing path.
    expect(refused).not.toMatch(/does not exist|not accessible/i);
    expect(h.assigned).toEqual([]);
    expect(h.offered).toEqual([h.source]);

    await h.grant(h.source);
    expect(await h.dispatch(scoped)).toMatch(/^Dispatched contract contract-/);
    const attempt = h.assigned[0].payload.taskAttempt;
    expect(attempt.contract.effects.writeScope.folderAccess).toEqual([
      { path: 'out', permission: 'readwrite' },
      { path: h.source, permission: 'read' },
    ]);
  });

  it('names a Folder Access limit as one, offers no grant for it, and calls a granted but absent file missing', async () => {
    const limited = host({ folderAccess: [{ path: '.', permission: 'readwrite' }] });
    const limit = await limited.dispatch(leaseContract(limited.source));
    expect(limit).toMatch(/explicit-limit: required input "lease"/);
    expect(limit).toContain('Folder Access');
    expect(limited.offered).toEqual([]);
    expect(limited.assigned).toEqual([]);

    const h = host();
    await h.grant(h.outside);
    const absent = path.join(h.outside, 'annex.txt');
    const missing = await h.dispatch(leaseContract(absent));
    expect(missing).toMatch(/missing-input: required input "lease"/);
    expect(missing).not.toMatch(/grant-needed/);
    expect(h.offered).toEqual([]);
    expect(h.assigned).toEqual([]);
  });
});

describe('v0.9.101 A1: a share, device or /net input is not touched before a grant covers it', () => {
  // Each spelling is what the host itself resolves as reaching another computer. Windows: a share or device; elsewhere,
  // the automounted /net, in any case and as resolved.
  const unreachable = process.platform === 'win32'
    ? ['\\\\203.0.113.7\\share\\lease.docx', '\\\\?\\UNC\\203.0.113.7\\share\\lease.docx', '\\\\.\\pipe\\lease', '//203.0.113.7/share/lease.docx']
    : ['/net/203.0.113.7/lease.docx', '/NET/host/lease.docx', '/tmp/../net/host/lease.docx'];

  it('is judged by its spelling: no metadata or other disk check, before a grant or Full access', () => {
    const h = host();
    const probe = { physical: vi.fn((target: string) => target), stat: vi.fn(() => { throw new Error('not probed'); }) };
    for (const target of unreachable) {
      expect(h.adapter.contractInputAccess(h.config, target, REQUEST, probe), target).toEqual({ status: 'grant-needed', unprobed: true });
    }
    const limited = { ...h.config, folderAccess: [{ path: h.root, permission: 'readwrite' as const }] };
    for (const target of unreachable) {
      expect(h.adapter.contractInputAccess(limited, target, REQUEST, probe), target).toEqual({ status: 'explicit-limit', unprobed: true });
    }
    expect(probe.physical).not.toHaveBeenCalled();
    expect(probe.stat).not.toHaveBeenCalled();
  });

  it('keeps it out of the scope admission resolves, and offers it as written', async () => {
    const roster: TeamRosterEntry[] = [
      { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
      { id: 'dev', role: 'senior-dev', name: 'Dev', status: 'idle',
        capabilities: { read: true, write: true, shell: false, verificationSensors: [], toolFamilies: ['read'], backend: 'openai-compat', taskScope: 'per-turn' } },
    ];
    const judged: DelegationTaskScope[] = [];
    const offered: string[] = [];
    const access: OutsideInputAccess = { status: 'grant-needed', unprobed: true };
    const view: TeamView = {
      list: () => roster,
      resolve: (ref) => (ref === 'dev' || ref === 'pm' ? { id: ref } : undefined),
      preflightTaskScope: (_agent, scope) => { judged.push(scope); return undefined; },
      offerTaskScopeAccess: () => { throw new Error('the scope is not offered for an input it cannot read'); },
      contractInputAccess: () => access,
      offerInputAccess: (target) => { offered.push(target); },
    };
    const root = folder();
    const store = new ContentAssetStore();
    cleanups.push(() => { void store.dispose(); });
    const tools = new TeamTools('pm', view, new MessageBus(), { timeoutMs: 1_000, taskInputResolver: new TaskInputResolver(store, root), cwd: root });
    const target = unreachable[0];
    const output = (await tools.runOutcome('dispatch_task', { agent: 'dev', instruction: 'Summarise it.', contract: leaseContract(target, {
      effects: { read_files: [], write_scope: { folder_access: [{ path: 'out', permission: 'readwrite' }] }, expected_file_effect: 'create' },
      required_capabilities: { version: 1, capabilities: ['read', 'write'] },
    }) })).output;
    expect(output).toMatch(/grant-needed: required input "lease"/);
    expect(judged.length).toBeGreaterThan(0);
    for (const scope of judged) expect(scope.folderAccess).toEqual([{ path: 'out', permission: 'readwrite' }]);
    expect(offered).toEqual([path.resolve(target)]);
  });
});
