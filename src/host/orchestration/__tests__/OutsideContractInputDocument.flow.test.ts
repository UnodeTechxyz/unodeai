import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageBus } from '../../../bus/MessageBus';
import { ContentAssetStore } from '../../../content/ContentAssetStore';
import { renderDocx, type DocumentZip } from '../../../content/document/DocxRenderer';
import { validateDocumentRequest } from '../../../content/document/DocumentValidation';
import { SessionLocalReadScopeConsent } from '../../../backend/localReadScope';
import { TeamTools, type TeamRosterEntry } from '../../../backend/TeamTools';
import { OrchestrationHostAdapter, type CoordinatorRuntimePort, type OrchestrationEvidencePort } from '../OrchestrationHostAdapter';
import { agentConfig, tempFolder } from '../../../views/__tests__/support/fileNavigationHost';
import type { AgentConfig, Message } from '../../../types';

/*
 * Smoke of 81f50826: "review this Word contract" with the contract outside the workspace. The PM put it in
 * contract.inputs as a dispatch snapshot; the teammate read the snapshot with read_extracted_content and got the Word
 * file's ZIP bytes as page text ("PK..[Content_Types].xml"), so it could not review it. The snapshot decoded any file's
 * bytes as UTF-8 (since v0.9.97). Here the real dispatch entry, admission, grant store and resolver run on a real Word
 * file, and the snapshot is read as the teammate's tool reads it.
 *
 * Not a mutation proof file: reading a Word file needs the document worker built under out/, which a mutation sandbox
 * does not have. Its proof is the binary-file test in TaskContract.test.
 */

vi.setConfig({ testTimeout: 60_000 });
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
const REQUEST = 'request-1';
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function folder(files: Record<string, string> = {}) {
  const made = tempFolder(files, 'unode-a1-doc-');
  cleanups.push(made.cleanup);
  return realpathSync.native(made.root);
}

async function wordLease(target: string): Promise<void> {
  const yazl = require('yazl') as { ZipFile: new () => DocumentZip };
  const rendered = await renderDocx(validateDocumentRequest({ schema_version: 1, path: 'lease.docx', format: 'docx',
    template: 'contract-v1', document: { title: 'MASTER LEASE AGREEMENT', language: 'en', blocks: [
      { type: 'clause', label: '2.1', content: [{ text: 'The Lessor provides the compute at Chief Telecom LY2.' }] },
    ] } }), () => new yazl.ZipFile());
  writeFileSync(target, Buffer.from(rendered.bytes));
}

async function host() {
  const root = folder({ 'notes.md': 'workspace' });
  const outside = folder();
  const source = path.join(outside, 'lease.docx');
  await wordLease(source);
  const consent = new SessionLocalReadScopeConsent(async () => false);
  const roster: TeamRosterEntry[] = [
    { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
    { id: 'dev', role: 'senior-dev', name: 'Dev', status: 'idle',
      capabilities: { read: true, write: true, shell: false, verificationSensors: [], toolFamilies: ['read', 'write'], backend: 'openai-compat', taskScope: 'per-turn' } },
  ];
  const configs: Record<string, AgentConfig> = {
    pm: agentConfig('pm', { backend: 'openai-compat', workingDirectory: root }),
    dev: agentConfig('dev', { backend: 'openai-compat', workingDirectory: root }),
  };
  const runtime: Partial<CoordinatorRuntimePort> = {
    workspace: () => ({ root: () => root, roots: () => [root], additionalReadRoots: () => [], isTrusted: () => true }),
    teamEntries: () => roster,
    resolveTeam: (ref) => (configs[ref] ? { id: ref } : undefined),
    configForAgent: (id) => configs[id],
    fullFileAccess: () => false,
    backendKindFor: (agent) => agent.backend ?? 'openai-compat',
    pathGrantsFor: (requestId) => consent.pathAccessFor(requestId),
    currentRequestId: () => REQUEST,
    offerPathAccess: () => undefined,
  };
  const adapter = new OrchestrationHostAdapter(runtime as CoordinatorRuntimePort, {} as OrchestrationEvidencePort);
  const store = new ContentAssetStore();
  cleanups.push(() => { void store.dispose(); });
  const bus = new MessageBus();
  const assigned: Message[] = [];
  bus.onType('task.assign', (message: Message) => { assigned.push(message); });
  const tools = new TeamTools('pm', adapter.makeTeamView(), bus, { timeoutMs: 1_000, taskInputResolver: adapter.createTaskInputResolver(store), cwd: root });
  const grant = (target: string) => consent.requestPathAccess(target, { requestId: REQUEST, isCurrent: () => true },
    async () => ({ permission: 'read' as const, lifetime: 'request' as const }));
  const dispatch = async (contract: Record<string, unknown>) =>
    (await tools.runOutcome('dispatch_task', { agent: 'dev', instruction: 'Review the lease in English and Chinese.', contract })).output;
  return { source, store, assigned, grant, dispatch };
}

describe('a Word contract outside the workspace, snapshotted for the teammate', () => {
  it('reaches the teammate as the document\'s text, and the original is unchanged', async () => {
    const h = await host();
    const before = sha256(readFileSync(h.source));
    expect(await h.grant(h.source)).toBeDefined();
    const dispatched = await h.dispatch({
      version: 1,
      objective: 'Review the lease in English and Traditional Chinese.',
      expected_deliverable: 'A bilingual review.',
      effects: { read_files: [], expected_file_effect: 'none' },
      inputs: [{ input_id: 'lease', kind: 'workspacePath', path: h.source, purpose: 'The contract to review', required: true,
        freshness: 'dispatch-snapshot', provenance: { kind: 'user-turn', source_refs: [] } }],
      constraints: [], dependencies: [],
      required_capabilities: { version: 1, capabilities: ['read'] },
      execution_strategy: 'delegate-required',
    });
    expect(dispatched).toMatch(/^Dispatched contract contract-/);
    const grant = h.assigned[0].payload.taskAttempt.grants.find((entry: { inputId: string }) => entry.inputId === 'lease');
    // What the teammate's read_extracted_content reads: the contract's words, not the file's ZIP bytes.
    const snapshot = await h.store.readExtractedContent(grant.resolvedContentAssetId, { start: 1, end: 1 });
    const text = 'error' in snapshot ? snapshot.error : snapshot.items.map((item) => item.text).join('');
    expect(text).toContain('MASTER LEASE AGREEMENT');
    expect(text).toContain('Chief Telecom LY2');
    expect(text).not.toContain('[Content_Types].xml');
    expect(text.startsWith('PK')).toBe(false);
    expect(sha256(readFileSync(h.source))).toBe(before);
  });
});
