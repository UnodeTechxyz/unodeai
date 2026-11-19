import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageBus } from '../../../bus/MessageBus';
import { ContentAssetStore } from '../../../content/ContentAssetStore';
import { renderDocx, type DocumentZip } from '../../../content/document/DocxRenderer';
import type { CanonicalDocumentRequest } from '../../../content/document/DocumentContracts';
import { SessionLocalReadScopeConsent } from '../../../backend/localReadScope';
import { TeamTools, type TeamRosterEntry } from '../../../backend/TeamTools';
import { WorkspaceTools } from '../../../backend/WorkspaceTools';
import { formatTaskAttemptCard } from '../../../backend/TaskContract';
import { statPlace, type StatPlace } from '../../../backend/requiredOutputDisk';
import { RunLedger } from '../../../observability/RunLedger';
import { finishedRequiredWork } from '../../../observability/RunRemaining';
import { OrchestrationHostAdapter, type CoordinatorRuntimePort, type OrchestrationEvidencePort } from '../OrchestrationHostAdapter';
import { agentConfig, tempFolder } from '../../../views/__tests__/support/fileNavigationHost';
import type { AgentConfig, Message } from '../../../types';

/*
 * v0.9.101 (G1, T101-1/T101-10): a version 2 task contract names the outputs the task is to leave. Here the real
 * dispatch entry (TeamTools dispatch_task), the host's real admission view and resolver, the real grant store and the
 * worker's real file tools run on real temporary folders. Only the delegate is fake: it records what it was handed.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

const REQUEST = 'request-1';

function folder(files: Record<string, string> = {}) {
  const made = tempFolder(files, 'unode-g1-');
  cleanups.push(made.cleanup);
  return realpathSync.native(made.root);
}

function host(dev: Partial<AgentConfig> = {}, statOutputPlace?: StatPlace) {
  const root = folder({ 'notes.md': 'workspace' });
  mkdirSync(path.join(root, 'out'));
  const outside = folder({ 'lease.txt': 'MASTER LEASE AGREEMENT\n' });
  const consent = new SessionLocalReadScopeConsent(async () => false);
  const roster: TeamRosterEntry[] = [
    { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
    {
      id: 'dev', role: 'senior-dev', name: 'Dev', status: 'idle',
      capabilities: { read: true, write: true, shell: false, verificationSensors: ['recorded-file-effect'], toolFamilies: ['read', 'write'], backend: 'openai-compat', taskScope: 'per-turn' },
    },
  ];
  const configs: Record<string, AgentConfig> = {
    pm: agentConfig('pm', { backend: 'openai-compat', workingDirectory: root }),
    dev: agentConfig('dev', { backend: 'openai-compat', workingDirectory: root, ...dev }),
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
  /** What the PM is handed when a task settles, as the host's async-result wake delivers it. */
  const results = new Map<string, string>();
  // The Run Ledger, as the host records dispatches and settled evidence into it.
  const ledger = new RunLedger();
  const tools = new TeamTools('pm', adapter.makeTeamView(), bus, { timeoutMs: 60_000, taskInputResolver: adapter.createTaskInputResolver(store), cwd: root,
    evidenceEnabled: true, onAsyncResultReady: (result) => { results.set(result.handle, result.text); return true; },
    onDelegationDispatched: (event) => ledger.recordDelegationDispatched({ ...event, originCorrelationId: 'contract-outputs' }),
    onDelegationEvidence: (event) => ledger.recordDelegationEvidence(event),
    ...(statOutputPlace ? { statOutputPlace } : {}) });
  /** A delegation as a reload restores it from the ledger. */
  const restored = (handle: string) => new RunLedger(ledger.snapshot()).snapshot()
    .flatMap((run) => run.delegations).find((delegation) => delegation.handle === handle)!;
  /** The person's own choice in the real grant store, as the Grant access notice makes it. */
  const grant = (target: string, permission: 'read' | 'readwrite') => consent.requestPathAccess(target,
    { requestId: REQUEST, isCurrent: () => true }, async () => ({ permission, lifetime: 'request' }));
  const dispatch = async (raw: Record<string, unknown>) =>
    (await tools.runOutcome('dispatch_task', { agent: 'dev', instruction: 'Write the bilingual summary.', contract: raw })).output;
  /** The dispatched teammate's own file tools, under the same live grants. */
  const workerTools = () => {
    const worker = new WorkspaceTools(root, new Set(['read', 'write']), 'dev');
    worker.setLivePathAccess(() => consent.pathAccessFor(REQUEST));
    return worker;
  };
  /**
   * The teammate's turn on a CLI route (field T2: Claude CLI): its host-built file tools with the real DOCX renderer,
   * feeding the turn's changed files through the same sink the Claude and Codex backends attach. `settle` ends the turn
   * with that evidence, as the backend's turn result carries it to the coordinator.
   */
  const workerTurn = () => {
    const worker = workerTools();
    worker.setDocumentRenderer({ render: async (request: CanonicalDocumentRequest) =>
      renderDocx(request, () => new (require('yazl') as { ZipFile: new () => DocumentZip }).ZipFile()) });
    const changedFiles = new Set<string>();
    worker.observeFileChanges((entry) => { changedFiles.add(entry.path); });
    worker.beginTurn();
    const message = assigned.at(-1)!;
    worker.setTaskAttempt(message.payload.taskAttempt);
    const handle = message.correlationId!;
    return {
      tools: worker, handle, changedFiles,
      settle: async (reply: string) => {
        bus.send('dev', 'pm', 'task.complete', { instruction: reply,
          metadata: { delegationEvidence: { hadToolActions: true, changedFiles: [...changedFiles] } } }, 'normal', handle);
        for (let round = 0; round < 3; round++) await new Promise<void>((resolve) => setTimeout(resolve, 2));
        return results.get(handle);
      },
    };
  };
  return { root, outside, adapter, assigned, grant, dispatch, workerTools, workerTurn, results, restored, config: configs.dev };
}

/** The T2 contract as version 2: the summary it is to leave is a required output. */
function summaryContract(outputs: unknown[], effects: Record<string, unknown> = { read_files: [], expected_file_effect: 'create' }): Record<string, unknown> {
  return {
    version: 2,
    objective: 'Write a bilingual summary of the lease.',
    expected_deliverable: 'A bilingual summary document.',
    effects,
    inputs: [],
    outputs,
    constraints: [],
    dependencies: [],
    required_capabilities: { version: 1, capabilities: ['read', 'write'] },
    execution_strategy: 'delegate-required',
  };
}

const SUMMARY = { output_id: 'summary', path: 'out/summary.docx', kind: 'file', required: true };
const scope = (...folderAccess: Array<{ path: string; permission: 'read' | 'readwrite' }>) =>
  ({ read_files: [], write_scope: { folder_access: folderAccess }, expected_file_effect: 'create' });

describe('v0.9.101 G1: a version 2 contract\'s required output, from dispatch_task to the teammate', () => {
  it('dispatches when the scope\'s write part holds it, refuses precisely as invalid-task-scope when it does not, and keeps the teammate\'s own authority with no scope', async () => {
    const h = host();

    const covered = await h.dispatch(summaryContract([SUMMARY], scope({ path: 'out', permission: 'readwrite' })));
    expect(covered).toMatch(/^Dispatched contract contract-/);
    expect(h.assigned).toHaveLength(1);
    const attempt = h.assigned[0].payload.taskAttempt;
    expect(attempt.contract).toMatchObject({ version: 2, outputs: [{ outputId: 'summary', path: 'out/summary.docx', kind: 'file', required: true }] });
    expect(attempt.contract.effects.writeScope.folderAccess).toEqual([{ path: 'out', permission: 'readwrite' }]);
    expect(attempt.baselineWorkspaceAuthority).toBe('narrowed-by-contract-scope');

    // The same output under a scope that only reads its folder: the contract is valid, the scope cannot carry it.
    const uncovered = await h.dispatch(summaryContract([SUMMARY], scope({ path: 'out', permission: 'read' }, { path: 'notes.md', permission: 'readwrite' })));
    expect(uncovered).not.toMatch(/invalid task contract/i);
    expect(uncovered).toBe('Error: task contract is not ready; no teammate was started. invalid-task-scope: required output '
      + '"summary" (out/summary.docx) is not inside a readwrite entry of contract.effects.write_scope, so the teammate could '
      + 'not write it. Add a readwrite entry that holds it, or leave write_scope out so the teammate\'s own access applies. '
      + 'The host neither widens the scope nor drops the output.');
    expect(h.assigned).toHaveLength(1);

    // No scope: the teammate works under its own authority, which the output neither narrows nor widens.
    const unscoped = await h.dispatch(summaryContract([SUMMARY]));
    expect(unscoped).toMatch(/^Dispatched contract contract-/);
    expect(unscoped).not.toMatch(/Required output/);
    expect(h.assigned).toHaveLength(2);
    expect(h.assigned[1].payload.taskAttempt.contract.effects.writeScope).toBeUndefined();
    expect(h.assigned[1].payload.taskAttempt.baselineWorkspaceAuthority).toBe('independent-agent-authority');
    // The card the teammate's backend shows it, from what it was handed.
    expect(formatTaskAttemptCard(h.assigned[1].payload.taskAttempt)).toContain('- summary [file; required]: out/summary.docx');
  });

  it('refuses a kind the existing target contradicts as an input error, and dispatches version 1 as before', async () => {
    const h = host();
    const folderAsFile = await h.dispatch(summaryContract([{ ...SUMMARY, path: 'out' }], scope({ path: 'out', permission: 'readwrite' })));
    expect(folderAsFile).toMatch(/^Error: invalid task contract\. contract\.outputs\[0\]\.kind is file, but out is an existing folder\./);
    expect(h.assigned).toEqual([]);

    const v1 = { ...summaryContract([]), version: 1 };
    delete v1.outputs;
    expect(await h.dispatch({ ...v1, outputs: [SUMMARY] })).toBe('Error: invalid task contract. contract contains unsupported '
      + 'field "outputs". contract.outputs needs contract.version 2.');
    expect(await h.dispatch(v1)).toMatch(/^Dispatched contract contract-/);
    expect(h.assigned[0].payload.taskAttempt.contract.version).toBe(1);
    expect(h.assigned[0].payload.taskAttempt.contract).not.toHaveProperty('outputs');
    expect(formatTaskAttemptCard(h.assigned[0].payload.taskAttempt)).not.toContain('Outputs');
  });
});

describe('v0.9.101 G1: an outside output is a requirement the teammate\'s live write access decides', () => {
  it('is named as not writable until a Read + Write grant, never by a read grant, as the teammate\'s own save is refused', async () => {
    const h = host();
    const target = path.join(h.outside, 'summary.docx');
    const contract = summaryContract([{ ...SUMMARY, path: target }]);
    const gap = `Required output "summary" (${target}) is outside the workspace, and the teammate may not write it yet `
      + '(Read is not Write): it can prepare the work, but cannot save it there until the user grants Read + Write for it. '
      + 'Tell the user exactly this, and do not tell them the output was saved.';

    // Ungranted: the work is dispatched (what needs no save goes on), and the gap is said as what it is.
    const ungranted = await h.dispatch(contract);
    expect(ungranted).toMatch(/^Dispatched contract contract-/);
    expect(ungranted).toContain(gap);
    expect((await h.workerTools().run('write_file', { path: target, content: 'summary' })).status).toBe('refused');

    // A read grant is not write.
    await h.grant(h.outside, 'read');
    expect(await h.dispatch(contract)).toContain(gap);
    expect((await h.workerTools().run('write_file', { path: target, content: 'summary' })).status).toBe('refused');

    // Read + Write: nothing is said, and the teammate's own tool saves it.
    await h.grant(h.outside, 'readwrite');
    const granted = await h.dispatch(contract);
    expect(granted).toMatch(/^Dispatched contract contract-/);
    expect(granted).not.toMatch(/Required output/);
    expect((await h.workerTools().run('write_file', { path: target, content: 'summary' })).status).not.toBe('refused');
  });

  it('names a Folder Access limit as one, and judges a share, device or /net output by its spelling alone', async () => {
    const limited = host({ folderAccess: [{ path: '.', permission: 'readwrite' }] });
    const target = path.join(limited.outside, 'summary.docx');
    const said = await limited.dispatch(summaryContract([{ ...SUMMARY, path: target }]));
    expect(said).toMatch(/^Dispatched contract contract-/);
    expect(said).toContain(`Required output "summary" (${target}) is outside the teammate's own Folder Access, a limit a grant does not widen`);
    // Folder Access that reads the outside folder is not write either.
    const reads = host();
    const readOnly = { ...reads.config, folderAccess: [{ path: '.', permission: 'readwrite' as const }, { path: reads.outside, permission: 'read' as const }] };
    expect(reads.adapter.contractOutputAccess(readOnly, path.join(reads.outside, 'summary.docx'), REQUEST)).toEqual({ status: 'explicit-limit' });
    expect(reads.adapter.contractOutputAccess({ ...readOnly, folderAccess: [{ path: reads.outside, permission: 'readwrite' }] },
      path.join(reads.outside, 'summary.docx'), REQUEST)).toEqual({ status: 'writable' });

    const h = host();
    const unreachable = process.platform === 'win32'
      ? ['\\\\203.0.113.7\\share\\summary.docx', '\\\\?\\UNC\\203.0.113.7\\share\\summary.docx']
      : ['/net/203.0.113.7/summary.docx', '/NET/host/summary.docx'];
    const physical = vi.fn((abs: string) => abs);
    for (const spelling of unreachable) {
      expect(h.adapter.contractOutputAccess(h.config, spelling, REQUEST, physical), spelling).toEqual({ status: 'grant-needed', unprobed: true });
    }
    expect(physical).not.toHaveBeenCalled();
  });
});

/*
 * v0.9.102 field fix 4 (field smoke T2 retest): the contract named an outside output by its absolute path, the folder was
 * granted Read + Write, and the teammate called write_document with the relative "output/..." spelling. That resolves
 * in the workspace, so the file landed in workspace\output; its receipt named no folder, and the task settled as if its
 * output were there. Through the real dispatch_task, the real admission and resolver, the real grant store and the
 * teammate's real host file tools with a real DOCX renderer: only the teammate's tool calls are made here.
 */
describe('v0.9.102 field fix 4: a required output written in another folder is said, with both places, when its task settles', () => {
  const PLAN = { sensors: ['recorded-file-effect'], none_applies: 'report-no-applicable-sensor' };
  const docx = (target: string) => ({ schema_version: 1, path: target, format: 'docx', template: 'contract-v1',
    document: { title: 'Summary', language: 'en', blocks: [{ type: 'paragraph', content: [{ text: 'SUMMARY' }] }] } });

  it('field T2: the receipt names the full path written; the result says the output is not at its contract path and where it was written, and the task is not verified', async () => {
    const h = host();
    await h.grant(h.outside, 'readwrite');
    for (const [n, verification] of [undefined, PLAN].entries()) {
      // Each round its own file: a document that already holds the same bytes is not a change.
      const target = path.join(h.outside, `summary-${n}.docx`);
      const landed = path.join(h.root, 'output', `summary-${n}.docx`);
      expect(await h.dispatch({ ...summaryContract([{ ...SUMMARY, path: target }]), ...(verification ? { verification_plan: verification } : {}) }))
        .toMatch(/^Dispatched contract contract-/);
      const turn = h.workerTurn();
      const saved = await turn.tools.run('write_document', docx(`output/summary-${n}.docx`));
      expect(saved).toMatchObject({ status: 'success', documentWrite: { code: 'written' } });
      // The receipt names the real folder, not only the spelling the teammate used.
      expect(saved.output).toContain(`Document written: output/summary-${n}.docx\n`);
      expect(saved.output).toContain(`Full path written: ${landed}\n`);
      expect(existsSync(target)).toBe(false);

      const result = await turn.settle('Saved the bilingual summary to the output folder.');
      expect(result, 'the PM was handed the result').toBeDefined();
      expect(result).toContain('[delegation: verification-failed]');
      expect(result).toContain(`[task state: required-output-not-written] required output "summary" not written at ${target}; written instead: ${landed}.`);
      expect(result).toContain('A required output of the task contract is not where the contract names it. Do not mark this step done');
      expect(result).not.toContain('[delegation: verified]');
      expect(result).not.toContain('[delegation: replied-not-verified]');
      if (verification) {
        // The declared file-effect sensor stands for the task's file effect: a file elsewhere does not pass it.
        expect(result).toContain('verification plan result: failed.');
      }
      // Nothing was moved or refused: the file the teammate wrote is where it wrote it.
      expect(readFileSync(landed).subarray(0, 2).toString()).toBe('PK');
    }
  });

  /*
   * v0.9.103 (field smoke of d71485c5; the Owner: fix): the teammate ran a script that wrote the required output. No
   * file tool wrote it, so nothing recorded it, and the result said it was not written while it was there.
   */
  it('v0.9.103: an output a command made at its contract path is observed on disk, said as such, and is not a missing output', async () => {
    const h = host();
    const made = path.join(h.root, 'out', 'long-job-done.txt');
    const output = { output_id: 'done', path: 'out/long-job-done.txt', kind: 'file', required: true };
    const mark = `[required output observed on disk] "done" is at ${made}: it was created or changed there after this task was `
      + 'dispatched, not by a file tool (for example by a command), so who wrote it is not recorded.';
    expect(await h.dispatch(summaryContract([output]))).toMatch(/^Dispatched contract contract-/);
    const turn = h.workerTurn();
    // The teammate's command writes it: no host file tool runs.
    writeFileSync(made, 'done after 2230 passes');
    const result = await turn.settle('Ran long-job.ps1; long-job-done.txt says: done after 2230 passes.');
    expect(result, 'the PM was handed the result').toBeDefined();
    expect(result).toContain(mark);
    expect(result).not.toContain('required-output-not-written');
    expect(result).not.toContain('[delegation: verification-failed]');

    // Changed again by a second task's command: observed again.
    await h.dispatch(summaryContract([output]));
    const second = h.workerTurn();
    writeFileSync(made, 'done after 2230 passes\nSECOND');
    const appended = await second.settle('Appended SECOND.');
    expect(appended).toContain(mark);
    expect(appended).not.toContain('required-output-not-written');

    // Control: there before the dispatch and untouched since, it was not written by this task.
    await h.dispatch(summaryContract([output]));
    const idle = h.workerTurn();
    const untouched = await idle.settle('Nothing to do.');
    expect(untouched).toContain(`[task state: required-output-not-written] required output "done" not written at ${made}; no file change was recorded for this task.`);
    expect(untouched).not.toContain('[required output observed on disk]');
  });

  // Codex's audit of 04be3005, finding 1: naming an outside output grants nothing, so the host never looks at it, or says
  // what is there, until the teammate may write it; a Folder Access limit is never looked past.
  it('v0.9.103: an outside output is looked at only once the teammate may write it, and never past its Folder Access', async () => {
    const looked: string[] = [];
    const recordingStat: StatPlace = (place) => { looked.push(place); return statPlace(place); };
    const h = host({}, recordingStat);
    const target = path.join(h.outside, 'private.txt');
    const output = { output_id: 'private', path: target, kind: 'file', required: true };
    // Ungranted: dispatched (the gap is said), never looked at; a process makes it, and nothing is said of it.
    expect(await h.dispatch(summaryContract([output]))).toContain(`Required output "private" (${target}) is outside the workspace`);
    const ungranted = h.workerTurn();
    writeFileSync(target, 'made by another process');
    const unseen = await ungranted.settle('Could not save it.');
    expect(unseen).toContain(`[task state: required-output-not-written] required output "private" not written at ${target}`);
    expect(unseen).not.toContain('[required output observed on disk]');
    expect(looked).not.toContain(target);

    // Codex's audit of 2b57dbe4, finding 1: granted while the task runs, its command's output is observed at settlement.
    const later = path.join(h.outside, 'later.txt');
    await h.dispatch(summaryContract([{ ...output, output_id: 'later', path: later }]));
    const during = h.workerTurn();
    expect(looked).not.toContain(later);
    await h.grant(h.outside, 'readwrite');
    writeFileSync(later, 'made by a command after the grant');
    const afterGrant = await during.settle('Ran it after the grant.');
    expect(afterGrant).toContain(`[required output observed on disk] "later" is at ${later}`);
    expect(afterGrant).not.toContain('required-output-not-written');
    // After a reload, the ledger counts it as written; the ungranted one above it does not.
    expect(finishedRequiredWork(h.restored(during.handle))).toBe(true);
    expect(finishedRequiredWork(h.restored(ungranted.handle))).toBe(false);

    // Read + Write granted before dispatch: looked at, and a command's output there is observed.
    const granted = path.join(h.outside, 'granted.txt');
    await h.dispatch(summaryContract([{ ...output, output_id: 'granted', path: granted }]));
    const turn = h.workerTurn();
    writeFileSync(granted, 'made by a command');
    expect(await turn.settle('Ran it.')).toContain(`[required output observed on disk] "granted" is at ${granted}`);
    expect(looked).toContain(granted);

    // Workspace-only Folder Access: never looked past it, granted or not.
    looked.length = 0;
    const limited = host({ folderAccess: [{ path: '.', permission: 'readwrite' }] }, recordingStat);
    const beyond = path.join(limited.outside, 'beyond.txt');
    await limited.dispatch(summaryContract([{ ...output, output_id: 'beyond', path: beyond }]));
    const capped = limited.workerTurn();
    writeFileSync(beyond, 'made elsewhere');
    expect(await capped.settle('Could not save it.')).not.toContain('[required output observed on disk]');
    expect(looked).not.toContain(beyond);
  });

  // Codex's audit of 04be3005, finding 2: a folder a command made at a required file's place is not that file.
  it('v0.9.103: a folder made where a required file belongs is not the file, and the task is not finished', async () => {
    const h = host();
    await h.dispatch(summaryContract([{ output_id: 'report', path: 'out/report.txt', kind: 'file', required: true }]));
    const turn = h.workerTurn();
    mkdirSync(path.join(h.root, 'out', 'report.txt'));
    const result = await turn.settle('Made the report.');
    expect(result).toContain(`[task state: required-output-not-written] required output "report" not written at ${path.join(h.root, 'out', 'report.txt')}`);
    expect(result).not.toContain('[required output observed on disk]');
  });

  it('control: written at its contract path, the same task is verified and says nothing of a missing output; a task with no required output is as before', async () => {
    const h = host();
    await h.grant(h.outside, 'readwrite');
    const target = path.join(h.outside, 'summary.docx');
    await h.dispatch({ ...summaryContract([{ ...SUMMARY, path: target }]), verification_plan: PLAN });
    const turn = h.workerTurn();
    const saved = await turn.tools.run('write_document', docx(target));
    expect(saved).toMatchObject({ status: 'success', documentWrite: { code: 'written' } });
    expect(saved.output).toContain(`Full path written: ${target}\n`);
    const result = await turn.settle('Saved the bilingual summary.');
    expect(result).toContain('[delegation: verified]');
    expect(result).toContain('verification plan result: satisfied.');
    expect(result).not.toContain('required-output-not-written');
    // v0.9.103: a file tool wrote it, so it is not said to have been made by something unrecorded.
    expect(result).not.toContain('[required output observed on disk]');
    expect(readFileSync(target).subarray(0, 2).toString()).toBe('PK');

    // An optional output is no requirement: written elsewhere, the task is judged as before.
    await h.dispatch({ ...summaryContract([{ ...SUMMARY, path: target, required: false }]), verification_plan: PLAN });
    const optional = h.workerTurn();
    expect((await optional.tools.run('write_file', { path: 'notes-2.md', content: 'notes' })).output)
      .toBe(`Wrote 5 bytes to notes-2.md (full path written: ${path.join(h.root, 'notes-2.md')}).`);
    const settled = await optional.settle('Wrote the notes.');
    expect(settled).toContain('[delegation: verified]');
    expect(settled).not.toContain('required-output-not-written');
  });
});
