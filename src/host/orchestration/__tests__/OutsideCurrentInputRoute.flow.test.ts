import { readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageBus } from '../../../bus/MessageBus';
import { ContentAssetStore } from '../../../content/ContentAssetStore';
import { SessionLocalReadScopeConsent } from '../../../backend/localReadScope';
import { ClaudeHeadlessBackend } from '../../../backend/ClaudeHeadlessBackend';
import { TeamTools, type TeamRosterEntry } from '../../../backend/TeamTools';
import { WorkspaceTools } from '../../../backend/WorkspaceTools';
import type { TaskAttemptCard } from '../../../backend/TaskContract';
import { OrchestrationHostAdapter, type CoordinatorRuntimePort, type OrchestrationEvidencePort } from '../OrchestrationHostAdapter';
import { agentConfig, tempFolder } from '../../../views/__tests__/support/fileNavigationHost';
import type { AgentConfig, Message } from '../../../types';

/*
 * v0.9.101 (T101-8): a granted outside input the teammate reads itself, during its task (freshness current). The host
 * reading the file is a host fact; the teammate's own tool must read it under the same access. The real dispatch entry
 * (TeamTools dispatch_task), the host's real admission view and resolver, the real grant store and each route's real
 * read tool run on real temporary folders: an OpenAI-compatible agent's host file tools, a Claude agent's UnodeAi files
 * bridge as its backend builds and serves it. Codex has no such tool, and admission says so. Only the model is absent:
 * the test makes the call the task card points the teammate to.
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const LEASE = 'MASTER LEASE AGREEMENT\nClause 1. The lessee leases the compute.\n';
const REQUEST = 'request-1';

function folder(files: Record<string, string> = {}) {
  const made = tempFolder(files, 'unode-t1018-');
  cleanups.push(made.cleanup);
  return realpathSync.native(made.root);
}

function host(options: { full?: boolean; claude?: Partial<AgentConfig> } = {}) {
  const root = folder({ 'notes.md': 'workspace' });
  const outside = folder({ 'lease.txt': LEASE });
  const source = path.join(outside, 'lease.txt');
  const consent = new SessionLocalReadScopeConsent(async () => false);
  const capabilities = (backend: string) => ({ read: true, write: true, shell: false, verificationSensors: [],
    toolFamilies: ['read', 'write'], backend, taskScope: backend === 'openai-compat' ? 'per-turn' as const : 'fixed-session-only' as const });
  const roster: TeamRosterEntry[] = [
    { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
    { id: 'dev', role: 'senior-dev', name: 'Dev', status: 'idle', capabilities: capabilities('openai-compat') },
    { id: 'claude-dev', role: 'senior-dev', name: 'Claude Dev', status: 'idle', capabilities: capabilities('claude') },
    { id: 'codex-dev', role: 'senior-dev', name: 'Codex Dev', status: 'idle', capabilities: capabilities('codex') },
  ];
  const configs: Record<string, AgentConfig> = {
    pm: agentConfig('pm', { backend: 'openai-compat', workingDirectory: root }),
    dev: agentConfig('dev', { backend: 'openai-compat', workingDirectory: root }),
    'claude-dev': agentConfig('claude-dev', { backend: 'claude', workingDirectory: root, allowedTools: ['read', 'write'],
      provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' }, autoApprove: true, ...options.claude }),
    'codex-dev': agentConfig('codex-dev', { backend: 'codex', workingDirectory: root }),
  };
  const offered: string[] = [];
  const runtime: Partial<CoordinatorRuntimePort> = {
    workspace: () => ({ root: () => root, roots: () => [root], additionalReadRoots: () => [], isTrusted: () => true }),
    teamEntries: () => roster,
    resolveTeam: (ref) => (configs[ref] ? { id: ref } : undefined),
    configForAgent: (id) => configs[id],
    fullFileAccess: () => options.full === true,
    backendKindFor: (agent) => agent.backend ?? 'openai-compat',
    pathGrantsFor: (requestId) => consent.pathAccessFor(requestId),
    currentRequestId: () => REQUEST,
    offerPathAccess: (_agentId, target) => { offered.push(target); },
  };
  const adapter = new OrchestrationHostAdapter(runtime as CoordinatorRuntimePort, {} as OrchestrationEvidencePort);
  const store = new ContentAssetStore();
  cleanups.push(() => store.dispose());
  const resolver = adapter.createTaskInputResolver(store);
  const bus = new MessageBus();
  const assigned: Message[] = [];
  bus.onType('task.assign', (message: Message) => { assigned.push(message); });
  const tools = new TeamTools('pm', adapter.makeTeamView(), bus, { timeoutMs: 1_000, taskInputResolver: resolver, cwd: root });
  /** The person's own choice in the real grant store, as the Grant access notice makes it. */
  const grant = async (target: string) => (await consent.requestPathAccess(target,
    { requestId: REQUEST, isCurrent: () => true }, async () => ({ permission: 'read', lifetime: 'request' })))!;
  const dispatch = async (agent: string, raw: Record<string, unknown>) =>
    (await tools.runOutcome('dispatch_task', { agent, instruction: 'Summarise the lease in English and Chinese.', contract: raw })).output;
  const card = (): TaskAttemptCard => assigned[assigned.length - 1].payload.taskAttempt;
  const readAt = (attemptId: string) => resolver.grantsForAttempt(attemptId).find((entry) => entry.inputId === 'lease')?.readAt;
  return { root, outside, source, consent, resolver, store, assigned, offered, grant, dispatch, card, readAt, configs };
}

/** The field contract, with the source read by the teammate itself during its task unless `freshness` says otherwise. */
function leaseContract(source: string, freshness: 'current' | 'dispatch-snapshot' = 'current'): Record<string, unknown> {
  return {
    version: 1,
    objective: 'Summarise the lease in English and Traditional Chinese.',
    expected_deliverable: 'A bilingual summary.',
    effects: { read_files: [], expected_file_effect: 'none' },
    inputs: [{
      input_id: 'lease', kind: 'workspacePath', path: source, purpose: 'The contract to summarise', required: true,
      freshness, provenance: { kind: 'user-turn', source_refs: [] },
    }],
    constraints: [],
    dependencies: [],
    required_capabilities: { version: 1, capabilities: ['read'] },
    execution_strategy: 'delegate-required',
  };
}

/** The Claude agent's backend as the host composes it for this request: the live grants, the resolver, Full access. */
async function claudeBridge(h: ReturnType<typeof host>) {
  const backend = new ClaudeHeadlessBackend(h.configs['claude-dev'], undefined, undefined, {
    livePathAccess: () => h.consent.pathAccessFor(REQUEST),
    taskInputResolver: h.resolver,
    fullFileAccess: () => false,
  });
  cleanups.push(() => backend.stop());
  await (backend as any).prepareFilesBridge(h.root);
  const bridgeId: string = (backend as any).bridgeIds.files;
  const served = (backend as any).filesBridgeServer.localTools.get('read_file');
  /** The bridge call Claude makes: by the served tool, as its MCP request reaches it. */
  const read = async (args: Record<string, unknown>) =>
    await served.handler(args, { signal: new AbortController().signal }) as { text: string; outcome: { status: string } };
  return { backend, bridgeId, read };
}

describe('v0.9.101 T101-8: a granted outside current input is read under the access admission counted', () => {
  it('OpenAI-compatible control: its own host file tools read it, record the read, and stop at the read when revoked', async () => {
    const h = host();
    const granted = await h.grant(h.source);
    expect(await h.dispatch('dev', leaseContract(h.source))).toMatch(/^Dispatched contract contract-/);
    const card = h.card();
    expect(card.grants.find((entry) => entry.inputId === 'lease')).toMatchObject({ sourceRef: h.source, agentId: 'dev' });
    expect(card.grants[0].resolvedContentAssetId).toBeUndefined();

    // The worker's real file tools, as the host gives them: the live grants and this attempt.
    const worker = new WorkspaceTools(h.root, new Set(['read']), 'dev');
    worker.setLivePathAccess(() => h.consent.pathAccessFor(REQUEST));
    worker.setTaskInputResolver(h.resolver);
    worker.setTaskAttempt(card);
    expect((await worker.run('read_file', { path: h.source })).output).toContain('Clause 1.');
    expect(h.readAt(card.attemptId)).toBeDefined();

    expect(h.consent.revokePathAccess(granted.id)).toBe(true);
    const revoked = await worker.run('read_file', { path: h.source });
    expect(revoked.status).not.toBe('success');
    expect(revoked.output).not.toContain('Clause 1.');
  });

  it('Claude: the task points it to its files bridge, whose read_file reads it under the live grant and records the read', async () => {
    const h = host();
    const granted = await h.grant(h.source);
    expect(await h.dispatch('claude-dev', leaseContract(h.source))).toMatch(/^Dispatched contract contract-/);
    const card = h.card();
    expect(card.agentId).toBe('claude-dev');

    const claude = await claudeBridge(h);
    const tool = `mcp__${claude.bridgeId}__read_file`;
    // The tool is on the surface the CLI is started with, and the turn names it for this input.
    expect((claude.backend as any).localMcpToolNames()).toContain(tool);
    const prompt: string = (claude.backend as any).turnText('Summarise the lease.', { taskAttempt: card }, false);
    expect(prompt).toContain(`Read input "lease", outside the workspace, with ${tool}.`);
    expect(prompt).toContain('Your own Read tool is not checked against that access');

    // The turn binds the attempt to the bridge, as the backend does when the task's turn starts.
    (claude.backend as any).filesBridgeTools.setTaskAttempt(card);
    const read = await claude.read({ path: h.source });
    expect(read.outcome.status).toBe('success');
    expect(read.text).toContain('Clause 1.');
    expect(h.readAt(card.attemptId)).toBeDefined();

    // Revoked: the bridge's own read refuses, at the read.
    expect(h.consent.revokePathAccess(granted.id)).toBe(true);
    const revoked = await claude.read({ path: h.source });
    expect(revoked.outcome.status).not.toBe('success');
    expect(revoked.text).not.toContain('Clause 1.');
  });

  it('Claude: an exact Folder Access file its bridge does not hold is not claimed readable for a current read', async () => {
    const outsideFile = { path: '', permission: 'read' as const };
    const h = host({ claude: { folderAccess: [{ path: '.', permission: 'readwrite' }, outsideFile] } });
    outsideFile.path = h.source;
    const refused = await h.dispatch('claude-dev', leaseContract(h.source));
    expect(refused).toMatch(/read-route: required input "lease"/);
    expect(h.assigned).toEqual([]);
    // The host can still read it, so a snapshot of it starts the same teammate.
    expect(await h.dispatch('claude-dev', leaseContract(h.source, 'dispatch-snapshot'))).toMatch(/^Dispatched contract contract-/);
  });

  it('Codex: no UnodeAi file tool of its own reads it under the grant, so it is not ready, precisely; a snapshot is', async () => {
    for (const full of [false, true]) {
      const h = host({ full });
      if (!full) await h.grant(h.source);
      const refused = await h.dispatch('codex-dev', leaseContract(h.source));
      expect(refused, `full=${full}`).toMatch(/read-route: required input "lease"/);
      expect(refused).toContain('dispatch-snapshot');
      // A grant would not change it: none is offered, and it is never called missing or ungranted.
      expect(refused).not.toMatch(/grant-needed|missing-input|explicit-limit|no regular file/);
      expect(h.offered).toEqual([]);
      expect(h.assigned).toEqual([]);

      // The same input as a host snapshot: the host reads it now, under that access, and hands the copy.
      expect(await h.dispatch('codex-dev', leaseContract(h.source, 'dispatch-snapshot'))).toMatch(/^Dispatched contract contract-/);
      const grant = h.card().grants.find((entry) => entry.inputId === 'lease')!;
      const snapshot = await h.store.readExtractedContent(grant.resolvedContentAssetId!, { start: 1, end: 1 });
      expect('error' in snapshot ? snapshot.error : snapshot.items.map((item) => item.text).join('')).toBe(readFileSync(h.source, 'utf8'));
    }
  });
});
