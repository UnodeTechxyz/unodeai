import { describe, expect, it } from 'vitest';
import { DelegationCancellationEvent, DelegationEvidenceRecord } from '../../backend/TeamTools';
import { Message } from '../../types';
import { createTurnContextManifest } from '../../session/TurnContextManifest';
import {
  acceptedWorkCountForPeriod,
  acceptedWorkCountForRun,
  latestRunVerdict,
  RunLedger,
  RUN_ACTIVITY_RETAINED_LIMIT,
  RUN_SCHEMA_VERSIONS,
  RUN_SUMMARY_DERIVED,
  RUN_SUMMARY_DIRECT_FIELDS,
  type StoredRunRecord,
} from '../RunLedger';
import { TurnOutcomeAccumulator, type TurnOutcomeReceiptV1 } from '../../session/turnOutcomeReceipt';
import { deriveRunMechanicalAccounting, renderRunEvidencePack, renderWorkerTaskProgressReport } from '../RunEvidencePack';
import { buildPortableRunEvidence } from '../PortableRunEvidence';
import { compileTaskContract } from '../../backend/TaskContract';

const evidence: DelegationEvidenceRecord = {
  outcome: 'verified',
  completionState: 'complete',
  changedFiles: ['src/feature.ts'],
  hadToolActions: true,
  verification: { ran: true, passed: true, command: 'npm test --token=not-for-export' },
  unrecordedWrites: false,
};

const phaseAProgress = {
  schemaVersion: 1 as const,
  correlationId: 'h-progress',
  agentId: 'dev',
  backend: 'claude' as const,
  model: 'claude-sonnet',
  startedAt: '2026-08-09T12:01:00.000Z',
  settledAt: '2026-08-09T12:07:00.000Z',
  durationMs: 360_000,
  modelRequests: 2,
  toolCalls: 4,
  inputTokens: 1234,
  fingerprintSequence: ['read_file:0123456789abcdef'],
  droppedFingerprintCount: 0,
  materialProgressCount: 1,
  lastMaterialProgressAt: '2026-08-09T12:02:00.000Z',
  longestNoMaterialProgressMs: 300_000,
  outcome: 'framework-evidenced-output' as const,
  hasFinalReply: true,
  terminalState: 'completed' as const,
};

function message(from: string, to: string, type: Message['type'], instruction = '', correlationId?: string): Message {
  return {
    id: `${from}-${to}-${type}-${Math.random()}`,
    ...(correlationId ? { correlationId } : {}),
    from,
    to,
    type,
    priority: 'normal',
    payload: { instruction },
    timestamp: '2026-08-09T12:00:00.000Z',
  };
}

describe('RunLedger', () => {
  // F7-20: the run a coordinator's turn thread belongs to, as one stable key for its delegation card.
  it('names a run by its origin thread, also from a woken turn that runs on the run id', () => {
    const ledger = new RunLedger();
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'h-1', requestedAgent: 'dev', agentId: 'dev',
      instruction: 'Build it.', originCorrelationId: 'origin-a',
    });
    expect(ledger.runPresentationKeyForCorrelation('pm', 'origin-a')).toBe('origin-a');
    expect(ledger.runPresentationKeyForCorrelation('pm', runId!)).toBe('origin-a');
    expect(ledger.runPresentationKeyForCorrelation('other-pm', 'origin-a')).toBeUndefined();
    expect(ledger.runPresentationKeyForCorrelation('pm', 'unknown-thread')).toBeUndefined();
  });

  it('keeps the auditable task contract internally and exports a context gap without prose or source identity', () => {
    const parsed = compileTaskContract({
      version: 1,
      objective: 'SECRET-CONTRACT-OBJECTIVE',
      expected_deliverable: 'SECRET-CONTRACT-DELIVERABLE',
      effects: { read_files: ['docs/private-source.md'], expected_file_effect: 'none' },
      inputs: [{
        input_id: 'owner_source', kind: 'workspacePath', purpose: 'SECRET-INPUT-PURPOSE', required: true,
        provenance: { kind: 'workspace', source_refs: ['SECRET-SOURCE-REF'] },
        freshness: 'current', path: 'docs/private-source.md',
      }],
      constraints: [{ text: 'SECRET-CONSTRAINT-TEXT', basis_refs: ['owner_source'] }],
      coordinator_brief: { text: 'SECRET-COORDINATOR-BRIEF', basis_refs: ['owner_source'] },
      dependencies: [],
      required_capabilities: { version: 1, capabilities: ['read'] },
      execution_strategy: 'delegate-required',
    }, 'pm');
    expect(parsed.contract).toBeDefined();
    const contract = parsed.contract!;
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'gap-handle', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Use the declared source.', contract, attemptId: 'attempt-private-123',
      originCorrelationId: 'root-gap',
    });
    ledger.recordDelegationEvidence({
      handle: 'gap-handle', agentId: 'dev', outcome: 'tool-activity-recorded', evidence: {
        outcome: 'tool-activity-recorded', changedFiles: [], hadToolActions: true,
        verification: { ran: false, passed: false }, unrecordedWrites: false,
        contextGaps: [{
          attemptId: 'attempt-private-123', contractId: contract.contractId, inputId: 'owner_source',
          reason: 'unreadable', purpose: 'SECRET-INPUT-PURPOSE', reportedAt: '2026-08-25T12:00:00.000Z',
        }],
        inputGrants: [{
          attemptId: 'attempt-private-123', agentId: 'dev', inputId: 'owner_source', kind: 'workspacePath',
          sourceRef: 'docs/private-source.md', suppliedAt: '2026-08-25T11:59:00.000Z',
          reachableAt: '2026-08-25T11:59:30.000Z',
        }],
      },
    });

    // Restart normalization keeps the internal audit record, including what the human reviewer needs.
    const [run] = new RunLedger(ledger.snapshot()).snapshot();
    expect(run.delegations[0]).toMatchObject({
      attemptId: 'attempt-private-123',
      contract: { objective: 'SECRET-CONTRACT-OBJECTIVE', coordinatorBrief: { text: 'SECRET-COORDINATOR-BRIEF', basisRefs: ['owner_source'] } },
      evidence: { contextGaps: [{ inputId: 'owner_source', reason: 'unreadable', purpose: 'SECRET-INPUT-PURPOSE' }] },
    });
    const internalPack = renderRunEvidencePack(run);
    expect(internalPack).toContain('SECRET-CONTRACT-OBJECTIVE');
    expect(internalPack).toContain('Task state **context-gap**');
    expect(internalPack).toContain('SECRET-INPUT-PURPOSE');
    expect(internalPack).not.toContain('SECRET-COORDINATOR-BRIEF');
    expect(internalPack).toContain('supplied **yes**; reachable **yes**; read receipt **not-observed**');
    for (const reason of ['missing', 'expired', 'outside-task-scope'] as const) {
      const projected = structuredClone(run);
      projected.delegations[0].evidence!.contextGaps![0].reason = reason;
      const rendered = renderRunEvidencePack(projected);
      expect(rendered).toContain(`reason **${reason}**`);
      expect(rendered).not.toContain('Unreadable');
      expect(rendered).not.toContain('host observed a read failure');
    }

    const portable = buildPortableRunEvidence(run);
    expect(portable.delegations[0].taskStates).toEqual([{ kind: 'context-gap', input: 'input-1', reason: 'unreadable' }]);
    expect(portable.delegations[0].inputReceipts).toEqual([{ input: 'input-1', supplied: true, reachable: true, readReceipt: 'not-observed' }]);
    const exported = JSON.stringify(portable);
    expect(exported).not.toContain('SECRET-');
    expect(exported).not.toContain('docs/private-source.md');
    expect(exported).not.toContain('owner_source');
    expect(exported).not.toContain('attempt-private-123');
    expect(portable.omitted.excluded.map((entry) => entry.field)).toEqual(expect.arrayContaining([
      'contract.objective', 'contract.expectedDeliverable', 'contract.input.purpose',
      'contract.constraint.text', 'contract.sourceIdentifiers', 'taskAttempt.id',
    ]));
  });

  it('retains a dispatch timeout as a distinct settled evidence verdict', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'timeout-handle', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Inspect the supplied source.', originCorrelationId: 'root-timeout',
    });
    ledger.recordDelegationEvidence({
      handle: 'timeout-handle', agentId: 'dev', outcome: 'timed-out', evidence: {
        outcome: 'timed-out', changedFiles: [], hadToolActions: false,
        verification: { ran: false, passed: false }, unrecordedWrites: false,
      },
    });

    const [run] = ledger.snapshot();
    expect(run.delegations[0]).toMatchObject({ state: 'settled', evidence: { outcome: 'timed-out' } });
    expect(renderRunEvidencePack(run)).toContain('**timed-out**');
  });

  it('closes a correlated run as partial only after every delegation is terminal and projects that fact', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'partial-handle', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Inspect it.', originCorrelationId: 'partial-root',
    });
    const partialWhileActive = message('pm', 'unode', 'task.partial', 'Interim report.', 'partial-root');
    partialWhileActive.payload.metadata = { completionState: 'partial', unfinishedActivity: 'Finish the table.' };
    ledger.observeMessage(partialWhileActive);
    expect(ledger.snapshot()[0]).toMatchObject({ status: 'open' });
    expect(ledger.snapshot()[0].closeoutCompletionState).toBeUndefined();
    expect(ledger.snapshot()[0].activity.at(-1)?.type).toBe('task.partial');

    ledger.recordDelegationEvidence({
      handle: 'partial-handle', agentId: 'dev', outcome: 'verified', evidence: {
        ...evidence, completionState: 'complete',
      },
    });
    ledger.observeMessage(partialWhileActive);

    const [run] = ledger.snapshot();
    expect(run).toMatchObject({ status: 'closed', closeoutCompletionState: 'partial', endedAt: partialWhileActive.timestamp });
    expect(ledger.list()[0]).toMatchObject({ closeoutCompletionState: 'partial' });
    expect(renderRunEvidencePack(run)).toContain('Status: **PARTIAL**');
    const portable = buildPortableRunEvidence(run);
    expect(portable).toMatchObject({ version: 'portable-run-evidence/5', closeoutCompletionState: 'partial' });
  });

  // The Owner, 2026-10-04: exported evidence that states its times in UTC must say that they are UTC.
  it('says in the evidence pack and in the progress report that their timestamps are UTC', () => {
    const ledger = new RunLedger();
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'utc-handle', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Inspect it.', originCorrelationId: 'utc-root', dispatchedAt: '2026-10-04T08:00:00.000Z',
    });
    ledger.recordDelegationEvidence({ handle: 'utc-handle', agentId: 'dev', outcome: 'verified', evidence });
    ledger.observeMessage({ ...message('pm', 'user', 'task.complete', 'Complete.', 'utc-root'), timestamp: '2026-10-04T08:05:00.000Z' });
    const pack = renderRunEvidencePack(ledger.get(runId)!, '2026-10-04T09:00:00.000Z');
    const statement = 'Timestamps in this document are UTC (Coordinated Universal Time), in ISO 8601 form with a trailing `Z`. They are not local times.';
    expect(pack).toContain(statement);
    // The statement stands before the first timestamp of the document.
    expect(pack.indexOf(statement)).toBeLessThan(pack.indexOf('2026-10-04T'));
    expect(pack).toContain('- Started (UTC): 2026-10-04T08:00:00.000Z');
    expect(pack).toContain('(closed 2026-10-04T08:05:00.000Z, UTC)');
    expect(pack).toContain('- Exported (UTC): 2026-10-04T09:00:00.000Z');

    const progress = renderWorkerTaskProgressReport(ledger.snapshot(), '2026-10-04T09:00:00.000Z');
    expect(progress).toContain('- Exported (UTC): 2026-10-04T09:00:00.000Z');
    expect(progress).toContain(statement);
  });

  it('records complete for the existing correlated closeout path', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'complete-handle', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Inspect it.', originCorrelationId: 'complete-root',
    });
    ledger.recordDelegationEvidence({ handle: 'complete-handle', agentId: 'dev', outcome: 'verified', evidence });
    ledger.observeMessage(message('pm', 'user', 'task.complete', 'Complete.', 'complete-root'));
    expect(ledger.snapshot()[0]).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });
  });

  it('forces a correlated complete closeout to partial when any delegation was interrupted', () => {
    const ledger = new RunLedger();
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'interrupted-closeout', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Deliver the release note.', originCorrelationId: 'interrupted-closeout-root',
      dispatchedAt: '2026-09-11T12:00:00.000Z',
    });
    ledger.reconcileRestoredActiveDelegations('2026-09-11T12:01:00.000Z');

    ledger.observeMessage(message(
      'pm', 'user', 'task.complete', 'Everything is complete.', 'interrupted-closeout-root',
    ));

    const run = ledger.get(runId)!;
    expect(run).toMatchObject({ status: 'closed', closeoutCompletionState: 'partial' });
    expect(renderRunEvidencePack(run)).toContain('Interrupted delegation handles: `interrupted-closeout`.');
    expect(renderRunEvidencePack(run)).toContain('Status: **PARTIAL**');
  });

  it('keeps host-derived read-receipt gaps in evidence, status, and the ledger without a disposition', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'unread-inputs', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Inspect the declared source.', originCorrelationId: 'root-unread',
    });
    ledger.recordDelegationEvidence({
      handle: 'unread-inputs', agentId: 'dev', outcome: 'required-input-read-not-observed', evidence: {
        outcome: 'required-input-read-not-observed', completionState: 'complete', changedFiles: [], hadToolActions: true,
        verification: { ran: false, passed: false }, unrecordedWrites: false,
        requiredInputCount: 3, requiredInputReadNotObservedCount: 3,
      },
    });

    const [run] = ledger.snapshot();
    expect(run.delegations[0].dispositions).toEqual([]);
    expect(run.delegations[0].evidence).toMatchObject({ requiredInputCount: 3, requiredInputReadNotObservedCount: 3 });
    expect(renderRunEvidencePack(run)).toContain('Required input receipts: declared **3**; read receipt not observed **3**');
    expect(ledger.inspectTaskStatus('pm', ['unread-inputs'])[0]).toMatchObject({
      evidenceOutcome: 'required-input-read-not-observed', requiredInputCount: 3, requiredInputReadNotObservedCount: 3,
    });
  });

  it('attaches a Phase A progress receipt that arrived before synchronous dispatch bookkeeping and exports its distribution', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationProgress({ handle: 'h-progress', agentId: 'dev', progress: phaseAProgress });
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'h-progress', requestedAgent: 'developer', agentId: 'dev', instruction: 'Inspect progress.',
      originCorrelationId: 'root-progress',
    });

    const [run] = ledger.snapshot();
    expect(run.delegations[0].progress).toMatchObject({ modelRequests: 2, longestNoMaterialProgressMs: 300_000 });
    expect(renderRunEvidencePack(run)).toContain('longest no-material-progress gap: **5m**');
    const report = renderWorkerTaskProgressReport([run]);
    expect(report).toContain('Tasks ≥ 5m (n=1)');
    expect(report).toContain('Separation assessment: **insufficient-data**');
    expect(report).toContain('| framework-evidenced-output | 1 |');
    expect(report).toContain('| no-framework-evidence | 0 |');
    expect(report).toContain('Separation needs at least **n=8** in each cohort.');
    expect(report).not.toContain('| mean |');
  });

  it('keeps one run-scoped, mechanical account through its final coordinator closeout', () => {
    const ledger = new RunLedger();
    const root = message('user', 'pm', 'ask.question', 'Implement the report with api_key=should-not-appear.');
    ledger.observeMessage(root);
    ledger.recordRefusedDispatch({ coordinatorId: 'pm', requestedAgent: 'missing', reason: 'No teammate named missing.', originCorrelationId: root.id });
    ledger.recordContextManifest('pm', createTurnContextManifest([
      {
        kind: 'repository-instruction', label: 'AGENTS.md', location: 'AGENTS.md', text: 'Use focused tests.', reason: 'repository instruction',
      },
      {
        kind: 'shared-memory', label: 'Shared team memory', location: '.unode/memory/notes.md',
        text: 'PRIVATE-MEMORY-NOTE-BODY', reason: 'same selected snapshot',
        memoryTrustCounts: { untrusted: 2, humanAttested: 1 },
      },
    ]), root.id);
    // SessionManager emits this synchronously while MessageBus delivers task.assign, before TeamTools
    // returns and records the dispatch receipt.
    ledger.recordTaskScopeApplied('h-1', { folderAccess: [{ path: 'src', permission: 'readwrite' }] }, '2026-08-09T12:01:01.000Z');
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'h-1', requestedAgent: 'developer', agentId: 'dev', instruction: 'Implement src/feature.ts',
      scope: { folderAccess: [{ path: 'src', permission: 'readwrite' }] }, dispatchedAt: '2026-08-09T12:01:00.000Z', originCorrelationId: root.id,
      scopeMode: 'per-turn-requested',
      routing: {
        taskClassification: 'implementation', requiredCapabilities: ['read', 'write'],
        compatibilityFilters: ['target-resolved', 'task-scope-per-turn-checked'], selectionReason: 'pinned by exact id',
      },
      route: {
        routeId: 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        connectionKind: 'openai-compatible',
        executionDomain: 'https://private-gateway.corp.example/v1',
        privacyDomain: {
          id: 'unresolved-user-selected:https://private-gateway.corp.example/v1|model-a',
          status: 'unresolved-user-selected',
        },
      },
    });
    ledger.recordContextManifest('dev', createTurnContextManifest([{
      kind: 'user-request', label: 'Current task', location: 'delegation', text: 'Implement src/feature.ts', reason: 'delegated instruction',
    }]), 'h-1');
    ledger.recordFileChange({
      agentId: 'dev', correlationId: 'h-1', path: 'src/feature.ts', before: 'old source', after: 'new source',
    });
    ledger.recordDelegationEvidence({ handle: 'h-1', agentId: 'dev', outcome: 'verified', evidence });
    ledger.recordDisposition({
      handle: 'h-1', agentId: 'dev', outcome: 'verified', disposition: 'accepted', recordedAt: '2026-08-09T12:02:00.000Z',
    });
    ledger.recordPermission({
      agentId: 'dev', kind: 'command-approval', decision: 'allowed', correlationId: 'h-1', approverId: 'local:machine-1',
    });
    ledger.recordPermission({ agentId: 'dev', kind: 'mcp-grant', decision: 'allowed', correlationId: 'h-1' });
    ledger.observeMessage(message('pm', 'user', 'task.complete', 'Complete.', root.id));

    const [run] = ledger.snapshot();
    expect(run.status).toBe('closed');
    expect(run.objective).toContain('api_key=[redacted]');
    expect(run.refusedDispatches).toHaveLength(1);
    expect(run.delegations[0]).toMatchObject({
      handle: 'h-1', state: 'settled', scopeMode: 'per-turn-enforced',
      temporaryScope: { readGrants: 0, readwriteGrants: 1, appliedAt: '2026-08-09T12:01:01.000Z' },
    });
    expect(run.delegations[0].evidence?.outcome).toBe('verified');
    expect(run.delegations[0].route?.executionDomain).toBe('https://private-gateway.corp.example/v1');
    expect(run.delegations[0].diffDigest).toMatchObject({ algorithm: 'sha256', files: [{ path: 'src/feature.ts' }] });
    expect(run.delegations[0].dispositions.map((entry) => entry.disposition)).toEqual(['accepted']);
    expect(run.permissions).toEqual([
      expect.objectContaining({ kind: 'command-approval', decision: 'allowed', approverId: 'local:machine-1' }),
      expect.objectContaining({ kind: 'mcp-grant', decision: 'allowed' }),
    ]);
    expect(run.permissions[1]).not.toHaveProperty('approverId');
    expect(run.contextReceipts.map((receipt) => receipt.agentId)).toEqual(['pm', 'dev']);
    const pack = renderRunEvidencePack(run);
    expect(pack).not.toContain('not-for-export');
    expect(pack).toContain('private-gateway.corp.example');
    expect(pack).toContain('by `local:machine-1`');
    expect(pack).toContain('no contemporaneous human approver recorded');
    expect(pack).toContain('Routing receipt: implementation');
    expect(pack).toContain('selected rows: 2 untrusted, 1 human-attested');
    expect(pack).not.toContain('PRIVATE-MEMORY-NOTE-BODY');
  });

  it('keeps only a bounded PDF receipt in the internal evidence pack', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'pdf-handle', requestedAgent: 'researcher', agentId: 'researcher', instruction: 'Read the document.',
      originCorrelationId: 'pdf-root',
    });
    ledger.recordContentReceipt({
      agentId: 'researcher', correlationId: 'pdf-handle', assetId: 'content-7', contentClass: 'pdf', action: 'read',
      extractionAttempted: true, extractionSucceeded: true, pages: { start: 1, end: 5, total: 42, extracted: 5 },
      truncated: false, ocrRequired: true,
      sourceUrl: 'https://private.example.test/a.pdf?secret=not-for-pack',
      extractedText: 'PDF-TEXT-NOT-FOR-PACK',
    } as Parameters<RunLedger['recordContentReceipt']>[0]);

    const [run] = ledger.snapshot();
    const pack = renderRunEvidencePack(run);
    expect(pack).toContain('## Bounded content consultation receipts');
    expect(pack).toContain('`content-7` | pdf | read | extraction succeeded; pages 1-5 of 42 (5 extracted)');
    expect(pack).toContain('OCR required: yes');
    expect(pack).not.toContain('private.example.test');
    expect(pack).not.toContain('PDF-TEXT-NOT-FOR-PACK');
  });

  it('records local-scope access without retaining a path, query, or file content, including in portable evidence', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'local-scope-handle', requestedAgent: 'researcher', agentId: 'researcher', instruction: 'Inspect sibling source.',
      originCorrelationId: 'local-scope-root',
    });
    ledger.recordContentReceipt({
      agentId: 'researcher', correlationId: 'local-scope-handle', contentClass: 'local-scope', action: 'tree-scan',
      rootId: 'local-scope-1', count: 17,
      path: 'C:\\Users\\alice', query: 'SECRET-LOCAL-SCOPE-QUERY', content: 'SECRET-LOCAL-SCOPE-CONTENT',
    } as Parameters<RunLedger['recordContentReceipt']>[0]);

    const [run] = ledger.snapshot();
    const internal = renderRunEvidencePack(run);
    const portable = buildPortableRunEvidence(run);
    expect(internal).toContain('local-scope-1 | local scope | tree-scan | 17 items');
    expect(internal).not.toContain('C:\\Users\\alice');
    expect(internal).not.toContain('SECRET-LOCAL-SCOPE-');
    expect(portable.content).toEqual([{
      ordinal: 'local-scope-1', contentClass: 'local-scope', action: 'tree-scan', count: 17,
    }]);
    expect(JSON.stringify(portable)).not.toContain('SECRET-LOCAL-SCOPE-');
    expect(JSON.stringify(portable)).not.toContain('C:\\Users\\alice');
  });

  it('keeps image routing evidence bounded to action, processing class and consent outcome', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'image-handle', requestedAgent: 'researcher', agentId: 'researcher', instruction: 'Inspect image.',
      originCorrelationId: 'image-root',
    });
    ledger.recordContentReceipt({
      agentId: 'researcher', correlationId: 'image-handle', assetId: 'content-8', contentClass: 'image', action: 'sent',
      processingClass: 'remote-vision', consentOutcome: 'approved',
      sourceUrl: 'https://private.example.test/image.png?secret=not-for-pack',
      bytes: 'RAW-IMAGE-BYTES-MUST-NOT-REACH-EVIDENCE', providerPayload: 'MODEL-PAYLOAD-MUST-NOT-REACH-EVIDENCE',
    } as Parameters<RunLedger['recordContentReceipt']>[0]);

    const [run] = ledger.snapshot();
    const internal = renderRunEvidencePack(run);
    const portable = buildPortableRunEvidence(run);
    expect(internal).toContain('`content-8` | image | sent | remote-vision; media consent: approved.');
    expect(internal).not.toContain('private.example.test');
    expect(internal).not.toContain('RAW-IMAGE-BYTES-MUST-NOT-REACH-EVIDENCE');
    expect(portable.content).toEqual([{
      ordinal: 'content-1', contentClass: 'image', action: 'sent', processingClass: 'remote-vision', consentOutcome: 'approved',
    }]);
    expect(JSON.stringify(portable)).not.toContain('MODEL-PAYLOAD-MUST-NOT-REACH-EVIDENCE');
  });

  it('records only own-conversation range facts, never transcript text or search terms', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'conversation-handle', requestedAgent: 'researcher', agentId: 'researcher', instruction: 'Recover an earlier decision.',
      originCorrelationId: 'conversation-root',
    });
    ledger.recordContentReceipt({
      agentId: 'researcher', correlationId: 'conversation-handle', contentClass: 'conversation', action: 'read',
      entries: { start: 4, end: 5, total: 19, returned: 2 },
      query: 'SECRET-CONVERSATION-QUERY', transcript: 'SECRET-CONVERSATION-TEXT',
    } as Parameters<RunLedger['recordContentReceipt']>[0]);

    const [run] = ledger.snapshot();
    const internal = renderRunEvidencePack(run);
    const portable = buildPortableRunEvidence(run);
    expect(internal).toContain('own conversation | read | entries 4-5 of 19 (2 returned)');
    expect(internal).not.toContain('SECRET-CONVERSATION-');
    expect(portable.content).toEqual([{
      ordinal: 'own-conversation', contentClass: 'conversation', action: 'read',
      entries: { start: 4, end: 5, total: 19, returned: 2 },
    }]);
    expect(JSON.stringify(portable)).not.toContain('SECRET-CONVERSATION-');
  });

  it('records an unscoped delegation as fixed session permissions, not task-level isolation', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'fixed-session', requestedAgent: 'writer', agentId: 'writer', instruction: 'Write copy.',
      scopeMode: 'fixed-session-permissions',
      routing: { taskClassification: 'general', requiredCapabilities: [], compatibilityFilters: ['fixed-session-permissions-used'], selectionReason: 'pinned by exact id' },
    });
    const run = ledger.snapshot()[0];
    expect(run.delegations[0].scopeMode).toBe('fixed-session-permissions');
    expect(renderRunEvidencePack(run)).toContain('fixed session permissions, not task-level isolation');
  });

  it('hashes source only at the write boundary and fails closed when either side was not observed', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'digest-handle', requestedAgent: 'dev', agentId: 'dev', instruction: 'Edit.',
    });
    ledger.recordFileChange({
      agentId: 'dev', correlationId: 'digest-handle', path: 'src/a.ts', before: 'before-canary', after: 'middle-canary',
    });
    ledger.recordFileChange({
      agentId: 'dev', correlationId: 'digest-handle', path: 'src/a.ts', before: 'middle-canary', after: 'after-canary',
    });

    let delegation = ledger.snapshot()[0].delegations[0];
    expect(delegation.diffDigest?.files[0]).toMatchObject({
      path: 'src/a.ts',
      beforeContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      afterContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(ledger.snapshot())).not.toMatch(/before-canary|middle-canary|after-canary/);

    // Claude can observe that an edit succeeded without being able to reconstruct its old bytes. `null`
    // would falsely mean "new file", so that production receipt makes the complete digest unavailable.
    ledger.recordFileChange({
      agentId: 'dev', correlationId: 'digest-handle', path: 'src/b.ts', before: null, after: 'after-only',
      contentObserved: false,
    });
    delegation = ledger.snapshot()[0].delegations[0];
    expect(delegation.diffDigest).toBeUndefined();
    expect(delegation.diffDigestUnavailable).toBe('file-content-not-observed');
    expect(JSON.stringify(ledger.snapshot())).not.toContain('after-only');
  });

  it('will not attach an approver to an MCP grant exercise even if a caller supplies one', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'mcp-handle', requestedAgent: 'dev', agentId: 'dev', instruction: 'Use MCP.',
    });
    ledger.recordPermission({
      agentId: 'dev', correlationId: 'mcp-handle', kind: 'mcp-grant', decision: 'allowed',
      approverId: 'local:plausible-but-false',
    });
    expect(ledger.snapshot()[0].permissions[0]).not.toHaveProperty('approverId');
  });

  it('does not let a later unrelated task close an open run', () => {
    const ledger = new RunLedger();
    const first = message('user', 'pm', 'ask.question', 'First task.');
    ledger.observeMessage(first);
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'first-handle', requestedAgent: 'developer', agentId: 'dev', instruction: 'First task work.',
      originCorrelationId: first.id,
    });
    ledger.recordDelegationEvidence({ handle: 'first-handle', agentId: 'dev', outcome: 'verified', evidence });

    const later = message('user', 'pm', 'ask.question', 'Unrelated later task.');
    ledger.observeMessage(later);
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'later-handle', requestedAgent: 'tester', agentId: 'qa', instruction: 'Later task work.',
      originCorrelationId: later.id,
    });
    ledger.recordDelegationEvidence({ handle: 'later-handle', agentId: 'qa', outcome: 'verified', evidence });
    ledger.observeMessage(message('pm', 'user', 'task.complete', 'Later task complete.', later.id));

    const runs = ledger.snapshot();
    const firstRun = runs.find((run) => run.delegations.some((delegation) => delegation.handle === 'first-handle'))!;
    const laterRun = runs.find((run) => run.delegations.some((delegation) => delegation.handle === 'later-handle'))!;
    expect(firstRun.status).toBe('open');
    expect(laterRun.status).toBe('closed');
    expect(firstRun.activity.map((item) => item.content)).not.toContain('Later task complete.');

    ledger.observeMessage(message('pm', 'user', 'task.complete', 'First task complete.', first.id));
    expect(ledger.snapshot().find((run) => run.id === firstRun.id)?.status).toBe('closed');
  });

  it('does not mix a reused worker\'s other-thread messages, context, or permissions into this run', () => {
    const ledger = new RunLedger();
    const root = message('user', 'pm', 'ask.question', 'Audit package A.');
    ledger.observeMessage(root);
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'run-a', requestedAgent: 'developer', agentId: 'dev', instruction: 'Audit A.', originCorrelationId: root.id,
    });
    ledger.observeMessage(message('dev', 'pm', 'task.status', 'A progress.', 'run-a'));
    ledger.recordContextManifest('dev', createTurnContextManifest([{
      kind: 'user-request', label: 'A task', location: 'delegation', text: 'Audit A.', reason: 'delegated instruction',
    }]), 'run-a');
    ledger.recordPermission({ agentId: 'dev', kind: 'command-approval', decision: 'allowed', correlationId: 'run-a' });

    ledger.observeMessage(message('dev', 'other-pm', 'task.status', 'B progress.', 'run-b'));
    ledger.recordContextManifest('dev', createTurnContextManifest([{
      kind: 'user-request', label: 'B task', location: 'delegation', text: 'Audit B.', reason: 'delegated instruction',
    }]), 'run-b');
    ledger.recordPermission({ agentId: 'dev', kind: 'command-approval', decision: 'denied', correlationId: 'run-b' });
    ledger.observeMessage(message('dev', 'pm', 'task.status', 'Unthreaded narration.'));

    const [run] = ledger.snapshot();
    expect(run.activity.map((item) => item.content)).toEqual(['Audit A.', 'A progress.']);
    expect(run.contextReceipts).toHaveLength(1);
    expect(run.contextReceipts[0].entries[0].label).toBe('A task');
    expect(run.permissions).toEqual([expect.objectContaining({ decision: 'allowed' })]);
  });

  it('derives Job B accounting from durable receipts without reconstructing chat history', () => {
    const ledger = new RunLedger();
    const root = message('user', 'pm', 'ask.question', 'Account for the round.');
    ledger.observeMessage(root);
    ledger.recordRefusedDispatch({ coordinatorId: 'pm', requestedAgent: 'missing', reason: 'No matching worker.', originCorrelationId: root.id });
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'h-1', requestedAgent: 'developer', agentId: 'dev', instruction: 'Inspect the first area.', originCorrelationId: root.id,
    });
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'h-2', requestedAgent: 'tester', agentId: 'qa', instruction: 'Inspect the second area.', originCorrelationId: root.id,
    });
    ledger.recordDelegationEvidence({ handle: 'h-1', agentId: 'dev', outcome: 'verified', evidence });
    ledger.recordDisposition({ handle: 'h-1', agentId: 'dev', outcome: 'verified', disposition: 'accepted', recordedAt: '2026-08-09T12:03:00.000Z' });
    ledger.recordDisposition({ handle: 'h-1', agentId: 'dev', outcome: 'verified', disposition: 'accepted-with-caveat', reason: 'Needs owner review.', recordedAt: '2026-08-09T12:04:00.000Z' });

    const run = ledger.snapshot()[0];
    expect(deriveRunMechanicalAccounting(run)).toMatchObject({
      dispatched: 2,
      settled: 1,
      refusedBeforeDispatch: 1,
      dispositions: [
        { handle: 'h-1', task: 'Inspect the first area.', disposition: 'accepted' },
        { handle: 'h-1', task: 'Inspect the first area.', disposition: 'accepted-with-caveat' },
      ],
    });
    const pack = renderRunEvidencePack(run);
    expect(pack).toContain('## Mechanical accounting');
    expect(pack).toContain('Dispatched: **2**');
    expect(pack).toContain('This pack proves that Job B');
  });

  it('records cancellation separately from results, evidence verdicts, and coordinator dispositions', () => {
    const ledger = new RunLedger();
    const root = message('user', 'pm', 'ask.question', 'Stop the delegated task.');
    ledger.observeMessage(root);
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'cancel-handle', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Work that will be stopped.', originCorrelationId: root.id,
    });
    const cancellation: DelegationCancellationEvent = {
      coordinatorId: 'pm', handle: 'cancel-handle', agentId: 'dev', reason: 'Stopped by user.',
      cancelledAt: '2026-08-10T12:03:00.000Z',
    };
    ledger.recordDelegationCancelled(cancellation);
    // Late evidence and a stray disposition callback cannot turn a cancellation into a result.
    ledger.recordDelegationEvidence({ handle: 'cancel-handle', agentId: 'dev', outcome: 'verified', evidence });
    ledger.recordDisposition({
      handle: 'cancel-handle', agentId: 'dev', outcome: 'verified', disposition: 'rejected',
      reason: 'must not attach to a cancellation', recordedAt: '2026-08-10T12:04:00.000Z',
    });
    ledger.observeMessage(message('pm', 'user', 'task.complete', 'Stopped.', root.id));

    const run = ledger.snapshot()[0];
    expect(run.status).toBe('closed');
    expect(run.delegations[0]).toMatchObject({
      state: 'cancelled', cancelledAt: cancellation.cancelledAt, cancellationReason: 'Stopped by user.', dispositions: [],
    });
    expect(run.delegations[0].evidence).toBeUndefined();
    expect(deriveRunMechanicalAccounting(run)).toMatchObject({ dispatched: 1, settled: 0, cancelled: 1, dispositions: [] });
    expect(renderRunEvidencePack(run)).toContain('Cancellation: 2026-08-10T12:03:00.000Z - Stopped by user.');
  });

  it('declares per-run omission even when the global activity window is irrelevant', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'h-1', requestedAgent: 'dev', agentId: 'dev', instruction: 'Inspect.' });
    for (let index = 0; index <= RUN_ACTIVITY_RETAINED_LIMIT; index++) {
      ledger.observeMessage(message('dev', 'pm', 'task.status', `progress ${index}`, 'h-1'));
    }

    const run = ledger.snapshot()[0];
    expect(run.activity).toHaveLength(RUN_ACTIVITY_RETAINED_LIMIT);
    expect(run.droppedActivityItems).toBe(2); // first dispatch + first status were evicted
    expect(renderRunEvidencePack(run)).toContain('**Incomplete:** 2 earlier activity item(s)');
  });

  it('reports a complete run excerpt independently of older unrelated global messages', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'h-1', requestedAgent: 'dev', agentId: 'dev', instruction: 'Inspect.' });
    ledger.observeMessage(message('other-pm', 'other-dev', 'task.status', 'unrelated'));
    const run = ledger.snapshot()[0];

    expect(run.droppedActivityItems).toBe(0);
    expect(renderRunEvidencePack(run)).toContain('**Complete for this run:**');
  });

  it('keeps an unterminated run open across persistence and excludes raw commands from the pack', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'h-1', requestedAgent: 'dev', agentId: 'dev', instruction: 'Check token=secretvalue.' });
    const restored = new RunLedger(ledger.snapshot());
    const run = restored.snapshot()[0];
    const pack = renderRunEvidencePack(run);

    expect(run.status).toBe('open');
    expect(pack).toContain('still open');
    expect(pack).not.toContain('secretvalue');
    expect(pack).toContain('plain Markdown');
  });

  // The pack is designed to be handed to a third party, so its own limits section must not state a
  // pattern match as if it were an exclusion. This repository has shipped that exact shape before:
  // CHANGELOG 0.9.29 asserted an absolute "ZERO network requests" that SECURITY.md then disclaimed.
  it('states the redaction limit as best effort, not as a guarantee', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'h-1', requestedAgent: 'dev', agentId: 'dev', instruction: 'Ship it.' });
    const pack = renderRunEvidencePack(ledger.snapshot()[0]);

    expect(pack).toContain('never enter this pack');
    expect(pack).toContain('not a guarantee');
    expect(pack).toContain('Review this pack before sharing it.');
    // The strong claim must not be extended over credentials, which are only pattern-matched.
    expect(pack).not.toMatch(/credential values are deliberately excluded/);
  });
});

describe('durable coordinator task status', () => {
  function dispatched(ledger: RunLedger, coordinatorId: string, handle: string, dispatchedAt: string): void {
    ledger.recordDelegationDispatched({
      coordinatorId,
      handle,
      requestedAgent: 'GRC Analyst',
      agentId: `${coordinatorId}-grc`,
      instruction: 'SECRET-INSTRUCTION --token=never-status',
      dispatchedAt,
      originCorrelationId: `${coordinatorId}-turn-${handle}`,
    });
  }

  it('projects active progress without consuming or mutating durable state (T2a/T2g)', () => {
    const ledger = new RunLedger();
    dispatched(ledger, 'pm', 'active-handle', '2026-08-29T01:00:00.000Z');
    ledger.recordDelegationProgress({ handle: 'active-handle', agentId: 'pm-grc', progress: phaseAProgress });
    const before = ledger.snapshot();

    const first = ledger.inspectTaskStatus('pm', ['active-handle']);
    const second = ledger.inspectTaskStatus('pm', ['active-handle']);

    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      handle: 'active-handle', lifecycle: 'active', progress: { activity: '4 tool calls observed' },
    });
    expect(first[0].delivery).toBeUndefined();
    expect(ledger.snapshot()).toEqual(before);
  });

  it('keeps settlement and mailbox delivery as independent durable observations (T2b/T2c/T2d/T2i)', () => {
    const ledger = new RunLedger();
    dispatched(ledger, 'pm', 'wake-handle', '2026-08-29T01:00:00.000Z');
    ledger.recordDelegationEvidence({ handle: 'wake-handle', agentId: 'pm-grc', outcome: 'verified', evidence });
    ledger.recordDeliveryPending('wake-handle', '2026-08-29T01:02:00.000Z');
    expect(ledger.inspectTaskStatus('pm', ['wake-handle'])[0]).toMatchObject({
      lifecycle: 'settled', delivery: { state: 'pending', observedAt: '2026-08-29T01:02:00.000Z' },
    });

    ledger.recordDeliveryDelivered('wake-handle', 'auto-wake', '2026-08-29T01:03:00.000Z');
    const restored = new RunLedger(ledger.snapshot());
    expect(restored.inspectTaskStatus('pm', ['wake-handle'])[0]).toMatchObject({
      lifecycle: 'settled', delivery: { state: 'delivered', via: 'auto-wake', observedAt: '2026-08-29T01:03:00.000Z' },
    });

    dispatched(restored, 'pm', 'collect-handle', '2026-08-29T01:04:00.000Z');
    restored.recordDelegationEvidence({ handle: 'collect-handle', agentId: 'pm-grc', outcome: 'verified', evidence });
    restored.recordDeliveryPending('collect-handle');
    restored.recordDeliveryDelivered('collect-handle', 'collect-ready', '2026-08-29T01:05:00.000Z');
    expect(restored.inspectTaskStatus('pm', ['collect-handle'])[0].delivery).toMatchObject({
      state: 'delivered', via: 'collect-ready',
    });

    const legacyRun = restored.snapshot()[0];
    legacyRun.schemaVersion = 4;
    delete legacyRun.delegations[0].delivery;
    expect(new RunLedger([legacyRun]).inspectTaskStatus('pm', ['wake-handle'])[0]).toMatchObject({
      lifecycle: 'settled', delivery: { state: 'not-observed' },
    });
  });

  it('returns cancellation distinctly and gives foreign or invented handles identical unknown rows (T2e/T2f)', () => {
    const ledger = new RunLedger();
    dispatched(ledger, 'pm', 'cancelled-handle', '2026-08-29T01:00:00.000Z');
    ledger.recordDelegationCancelled({
      coordinatorId: 'pm', handle: 'cancelled-handle', agentId: 'pm-grc', reason: 'owner stopped it',
      cancelledAt: '2026-08-29T01:01:00.000Z',
    });
    dispatched(ledger, 'other-pm', 'foreign-handle', '2026-08-29T01:02:00.000Z');

    expect(ledger.inspectTaskStatus('pm', ['cancelled-handle'])[0]).toMatchObject({ lifecycle: 'cancelled' });
    expect(ledger.inspectTaskStatus('pm', ['cancelled-handle'])[0].delivery).toBeUndefined();
    expect(ledger.inspectTaskStatus('pm', ['foreign-handle', 'invented-handle'])).toEqual([
      { handle: 'foreign-handle', lifecycle: 'unknown' },
      { handle: 'invented-handle', lifecycle: 'unknown' },
    ]);
  });

  it('lists this coordinator recent history newest-first and exposes no result/source/command data (T2h/T2k)', () => {
    const ledger = new RunLedger();
    dispatched(ledger, 'pm', 'older-handle', '2026-08-29T01:00:00.000Z');
    ledger.recordDelegationEvidence({ handle: 'older-handle', agentId: 'pm-grc', outcome: 'verified', evidence: {
      ...evidence,
      changedFiles: ['C:\\Private\\SECRET-SOURCE.txt'],
      verification: { ran: true, passed: true, command: 'printenv SECRET_ENV' },
    } });
    ledger.recordDeliveryDelivered('older-handle', 'blocking-tool');
    dispatched(ledger, 'pm', 'newer-handle', '2026-08-29T02:00:00.000Z');
    dispatched(ledger, 'other-pm', 'other-handle', '2026-08-29T03:00:00.000Z');

    const rows = ledger.inspectTaskStatus('pm');
    expect(rows.map((row) => row.handle)).toEqual(['newer-handle', 'older-handle']);
    expect(rows.every((row) => typeof row.runId === 'string')).toBe(true);
    const rendered = JSON.stringify(rows);
    expect(rendered).not.toContain('SECRET-INSTRUCTION');
    expect(rendered).not.toContain('SECRET-SOURCE');
    expect(rendered).not.toContain('printenv');
    expect(rendered).not.toContain('SECRET_ENV');
    expect(rendered).not.toContain('other-handle');
  });
});

describe('human run verdicts', () => {
  function closedRun(): { ledger: RunLedger; runId: string } {
    const ledger = new RunLedger();
    const root = message('user', 'pm', 'ask.question', 'Deliver the feature.');
    ledger.observeMessage(root);
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'human-verdict', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Implement the feature.', originCorrelationId: root.id,
    });
    ledger.recordDelegationEvidence({ handle: 'human-verdict', agentId: 'dev', outcome: 'verified', evidence });
    ledger.recordDisposition({
      handle: 'human-verdict', agentId: 'dev', outcome: 'verified', disposition: 'accepted',
      recordedAt: '2026-08-24T12:00:00.000Z',
    });
    ledger.observeMessage(message('pm', 'user', 'task.complete', 'Done.', root.id));
    return { ledger, runId };
  }

  it('keeps a closed, coordinator-accepted and verified run explicitly unjudged until a human records a verdict', () => {
    const { ledger, runId } = closedRun();
    const before = ledger.get(runId)!;

    expect(before.status).toBe('closed');
    expect(latestRunVerdict(before)).toBeUndefined();
    expect(acceptedWorkCountForRun(before)).toBe(0);
    expect(ledger.list().find((run) => run.id === runId)).not.toHaveProperty('verdict');
  });

  it('requires a contemporaneous approver and unresolved items for accepted-with-exceptions, then appends rather than overwriting', () => {
    const { ledger, runId } = closedRun();
    const evidenceReviewedAt = '2026-08-24T12:01:00.000Z';

    expect(ledger.recordVerdict({ runId, verdict: 'accepted', evidenceReviewedAt })).toBe(false);
    expect(ledger.recordVerdict({ runId, verdict: 'accepted-with-exceptions', approverId: 'local:owner-1', evidenceReviewedAt })).toBe(false);
    expect(ledger.recordVerdict({
      runId, verdict: 'accepted-with-exceptions', approverId: 'local:owner-1', evidenceReviewedAt,
      unresolvedItems: ['Add a release note.'], recordedAt: '2026-08-24T12:02:00.000Z',
    })).toBe(true);
    expect(ledger.recordVerdict({
      runId, verdict: 'accepted', approverId: 'local:owner-1', evidenceReviewedAt,
      unresolvedItems: ['A non-blocking follow-up is permitted for a full acceptance.'], recordedAt: '2026-08-24T12:02:30.000Z',
    })).toBe(true);
    expect(ledger.recordVerdict({
      runId, verdict: 'rejected', approverId: 'local:owner-2', evidenceReviewedAt,
      recordedAt: '2026-08-24T12:03:00.000Z',
    })).toBe(true);

    const run = ledger.get(runId)!;
    expect(run.verdicts).toHaveLength(3);
    expect(run.verdicts[0].unresolvedItems).toEqual(['Add a release note.']);
    expect(latestRunVerdict(run)).toMatchObject({ verdict: 'rejected', approverId: 'local:owner-2' });
  });

  it('loads a pre-v0.9.59 persisted run as unjudged and counts only human acceptance inside the requested period', () => {
    const { ledger, runId } = closedRun();
    const legacy = ledger.get(runId)!;
    legacy.schemaVersion = 3;
    delete legacy.verdicts;
    const restored = new RunLedger([legacy]);
    const run = restored.get(runId)!;
    expect(latestRunVerdict(run)).toBeUndefined();
    expect(acceptedWorkCountForRun(run)).toBe(0);

    expect(restored.recordVerdict({
      runId, verdict: 'accepted', approverId: 'local:owner-1', evidenceReviewedAt: '2026-08-24T14:00:00.000Z',
      recordedAt: '2026-08-24T14:00:00.000Z',
    })).toBe(true);
    expect(acceptedWorkCountForPeriod(restored.snapshot(), {
      startsAt: '2026-08-24T13:00:00.000Z', endsAt: '2026-08-24T15:00:00.000Z',
    })).toBe(1);
    expect(acceptedWorkCountForPeriod(restored.snapshot(), {
      startsAt: '2026-08-24T15:00:00.000Z', endsAt: '2026-08-24T16:00:00.000Z',
    })).toBe(0);
  });

  it('drops a persisted system-authored verdict through the shared verdict normalizer', () => {
    const { ledger, runId } = closedRun();
    const raw = ledger.get(runId)!;
    raw.verdicts = [{
      verdict: 'accepted',
      approverId: 'system:host-disposed',
      recordedAt: '2026-08-24T14:00:00.000Z',
      evidenceReviewedAt: '2026-08-24T14:00:00.000Z',
      unresolvedItems: [],
    }];

    const restored = new RunLedger([raw]);
    const restoredRun = restored.get(runId)!;
    expect(restoredRun.verdicts).toEqual([]);
    expect(restoredRun.verdictWithholdings).toEqual([{
      reason: 'non-human-approver',
      acceptedVerdictCount: 0,
    }]);
    expect(renderRunEvidencePack(restoredRun)).toMatch(/Stored verdict: \*\*WITHHELD\*\*.*human approver/i);
    expect(renderRunEvidencePack(restoredRun)).not.toContain('system:host-disposed');
    expect(latestRunVerdict(raw)).toBeUndefined();
  });

  it('preserves verdict ordering when invalid persisted values are separated from accepted verdicts', () => {
    const { ledger, runId } = closedRun();
    const valid = {
      verdict: 'accepted' as const,
      approverId: 'local:owner-1',
      recordedAt: '2026-08-24T14:00:00.000Z',
      evidenceReviewedAt: '2026-08-24T14:00:00.000Z',
      unresolvedItems: [],
    };
    const invalid = {
      ...valid,
      approverId: 'system:host-disposed',
      recordedAt: '2026-08-24T14:01:00.000Z',
    };

    const invalidLast = ledger.get(runId)!;
    invalidLast.verdicts = [valid, invalid];
    const withheld = new RunLedger([invalidLast]).get(runId)!;
    expect(latestRunVerdict(withheld)).toBeUndefined();
    expect(acceptedWorkCountForRun(withheld)).toBe(0);
    expect(withheld.verdictWithholdings).toEqual([{
      reason: 'non-human-approver',
      acceptedVerdictCount: 1,
    }]);

    const validLast = ledger.get(runId)!;
    validLast.verdicts = [invalid, valid];
    const accepted = new RunLedger([validLast]).get(runId)!;
    expect(latestRunVerdict(accepted)).toMatchObject({ approverId: 'local:owner-1' });
    expect(acceptedWorkCountForRun(accepted)).toBe(1);
  });
});

describe('v0.9.70 review and policy receipts', () => {
  it('round-trips a v8 partial closeout through the field whitelist', () => {
    const ledger = new RunLedger();
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'round-trip', requestedAgent: 'dev', agentId: 'dev',
      instruction: 'Do it.', originCorrelationId: 'round-trip-root',
    });
    ledger.recordDelegationEvidence({ handle: 'round-trip', agentId: 'dev', outcome: 'verified', evidence });
    const partial = message('pm', 'user', 'task.partial', 'Report.', 'round-trip-root');
    partial.payload.metadata = { completionState: 'partial', unfinishedActivity: 'One item remains.' };
    ledger.observeMessage(partial);

    const restored = new RunLedger(ledger.snapshot()).get(runId)!;
    expect(restored).toMatchObject({ schemaVersion: 10, status: 'closed', closeoutCompletionState: 'partial' });
  });

  it('migrates a v6 receipt snapshot and old outcome without losing the delegation', () => {
    const ledger = new RunLedger();
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'v6-handle', requestedAgent: 'dev', agentId: 'dev',
      instruction: 'Inspect it.', originCorrelationId: 'v6-root',
    });
    ledger.recordDelegationEvidence({
      handle: 'v6-handle', agentId: 'dev', outcome: 'required-input-read-not-observed', evidence: {
        ...evidence,
        outcome: 'required-input-read-not-observed',
        requiredInputCount: 1,
        requiredInputReadNotObservedCount: 1,
      },
    });
    ledger.observeMessage(message('pm', 'user', 'task.complete', 'Done.', 'v6-root'));
    const legacy = ledger.get(runId)! as any;
    legacy.schemaVersion = 6;
    delete legacy.closeoutCompletionState;
    legacy.delegations[0].evidence.outcome = 'required-inputs-unread';
    legacy.delegations[0].evidence.unreadRequiredInputCount = 1;
    delete legacy.delegations[0].evidence.requiredInputReadNotObservedCount;
    delete legacy.delegations[0].evidence.receiptSnapshots;

    const restored = new RunLedger([legacy]).get(runId)!;
    expect(restored).toMatchObject({ schemaVersion: 10, closeoutCompletionState: 'complete' });
    expect(restored.delegations[0]).toMatchObject({
      state: 'settled',
      evidence: {
        outcome: 'required-input-read-not-observed',
        requiredInputReadNotObservedCount: 1,
        receiptSnapshots: { terminal: { requiredInputCount: 1, requiredInputReadNotObservedCount: 1 } },
      },
    });
  });

  it('persists a content-free exact-attempt review observation and restores old records as not observed', () => {
    const ledger = new RunLedger();
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'review-handle', requestedAgent: 'reviewer', agentId: 'reviewer',
      instruction: 'SECRET REVIEW PROMPT', attemptId: 'review-attempt', originCorrelationId: 'root-review',
    });
    ledger.recordReviewObservation({
      schemaVersion: 1,
      artifactId: 'artifact-1',
      reviewInputId: 'artifact',
      producerAttemptId: 'producer-attempt',
      reviewerAttemptId: 'review-attempt',
      artifactReadAt: '2026-08-29T10:00:00.000Z',
      sameReportedModel: false,
      sameConfiguredRouteAndModel: false,
      policyDecision: 'allowed-different-reported-model',
      observedAt: '2026-08-29T10:00:01.000Z',
    });
    const restored = new RunLedger(ledger.snapshot()).get(runId)!;
    expect(restored.schemaVersion).toBe(10);
    expect(restored.reviewObservations).toEqual([expect.objectContaining({
      reviewerAttemptId: 'review-attempt',
      sameReportedModel: false,
      sameConfiguredRouteAndModel: false,
    })]);
    expect(JSON.stringify(restored.reviewObservations)).not.toMatch(/route-a|reported-a|SECRET REVIEW PROMPT|source content/i);

    const legacy = structuredClone(restored);
    legacy.schemaVersion = 5;
    delete legacy.reviewObservations;
    expect(new RunLedger([legacy]).get(runId)?.reviewObservations).toEqual([]);
  });

  it('normalizes v1, v8 and v9 stored rows to the same total in-memory arrays', () => {
    const ledger = new RunLedger();
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'legacy-shape', requestedAgent: 'developer', agentId: 'developer',
      instruction: 'Inspect the stored shape.',
    });
    const v9 = ledger.get(runId)!;
    const v8: StoredRunRecord = structuredClone(v9);
    v8.schemaVersion = 8;
    delete v8.turnOutcomes;
    delete v8.droppedTurnOutcomes;
    const v1: StoredRunRecord = structuredClone(v8);
    v1.schemaVersion = 1;
    delete v1.outcomeRepairs;
    delete v1.verdicts;
    delete v1.contentReceipts;
    delete v1.reviewObservations;

    const restored = new RunLedger([v1, v8, v9]).snapshot();
    expect(RUN_SCHEMA_VERSIONS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const run of restored) {
      expect(run.schemaVersion).toBe(10);
      expect(run.outcomeRepairs).toEqual([]);
      expect(run.verdicts).toEqual([]);
      expect(run.contentReceipts).toEqual([]);
      expect(run.reviewObservations).toEqual([]);
      // A row from before v9 recorded no turn outcomes: an empty list, which no reader may count as zero tools.
      expect(run.turnOutcomes).toEqual([]);
      expect(run.droppedTurnOutcomes).toBe(0);
      // A row from before v10 recorded no turn entries: not recorded, never a turn that took no time.
      expect(run.turns).toEqual([]);
      expect(run.droppedTurns).toBe(0);
    }

    const unsupported = { ...v9, schemaVersion: 11 } as unknown as StoredRunRecord;
    expect(new RunLedger([unsupported]).snapshot()).toEqual([]);
  });

  it('projects direct and computed summary fields from their declarations', () => {
    const ledger = new RunLedger();
    const root = message('user', 'pm', 'ask.question', 'Ship it.', 'summary-root');
    ledger.observeMessage(root);
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'summary-handle', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Ship it.', originCorrelationId: root.id,
    });
    ledger.recordDelegationEvidence({ handle: 'summary-handle', agentId: 'dev', outcome: 'verified', evidence });
    ledger.observeMessage(message('pm', 'user', 'task.complete', 'Done.', root.id));
    ledger.recordVerdict({
      runId, verdict: 'accepted', approverId: 'local:owner', evidenceReviewedAt: '2026-09-01T10:01:00.000Z',
      recordedAt: '2026-09-01T10:01:00.000Z',
    });

    const run = ledger.get(runId)!;
    const [summary] = ledger.list();
    expect(RUN_SUMMARY_DIRECT_FIELDS).toEqual([
      'id', 'coordinatorId', 'status', 'startedAt', 'closeoutCompletionState', 'objective',
    ]);
    for (const field of RUN_SUMMARY_DIRECT_FIELDS) {
      expect(summary[field]).toEqual(run[field]);
    }
    expect(RUN_SUMMARY_DERIVED.verdict.from).toEqual(['verdicts', 'verdictWithholdings']);
    expect(summary.verdict).toBe('accepted');
  });

  it('records policy-refused durably without fabricating a worker delegation or no-executor state', () => {
    const ledger = new RunLedger();
    ledger.recordRefusedDispatch({
      coordinatorId: 'pm', handle: 'refused-handle', requestedAgent: 'reviewer',
      reason: 'Same reported model identity.', recordedAt: '2026-08-29T11:00:00.000Z',
      originCorrelationId: 'root-refused', taskState: 'policy-refused',
      policyId: 'artifact-review-different-reported-model-v1',
    });
    const [run] = ledger.snapshot();
    expect(run.delegations).toEqual([]);
    expect(run.refusedDispatches).toEqual([expect.objectContaining({ taskState: 'policy-refused' })]);
    expect(new RunLedger([run]).inspectTaskStatus('pm', ['refused-handle'])).toEqual([expect.objectContaining({
      lifecycle: 'policy-refused',
      policyId: 'artifact-review-different-reported-model-v1',
    })]);
    expect(new RunLedger([run]).inspectTaskStatus('other', ['refused-handle'])).toEqual([
      { handle: 'refused-handle', lifecycle: 'unknown' },
    ]);
  });

  it('reconciles restored active work to a durable interruption with both observation timestamps', () => {
    const ledger = new RunLedger();
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'orphaned-handle', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Continue the release.', attemptId: 'attempt-orphaned',
      originCorrelationId: 'root-orphaned', dispatchedAt: '2026-09-11T10:00:00.000Z',
    });

    const restored = new RunLedger(ledger.snapshot());
    expect(restored.reconcileRestoredActiveDelegations('2026-09-11T10:05:00.000Z')).toEqual([{
      coordinatorId: 'pm', handle: 'orphaned-handle', agentId: 'dev', attemptId: 'attempt-orphaned',
      reason: 'host-restarted', lastObservedAt: '2026-09-11T10:00:00.000Z', detectedAt: '2026-09-11T10:05:00.000Z',
    }]);
    expect(restored.inspectTaskStatus('pm', ['orphaned-handle'])[0]).toMatchObject({
      lifecycle: 'interrupted',
      interruption: {
        reason: 'host-restarted',
        lastObservedAt: '2026-09-11T10:00:00.000Z',
        detectedAt: '2026-09-11T10:05:00.000Z',
      },
    });
    expect(new RunLedger(restored.snapshot()).get(runId)?.delegations[0]).toMatchObject({
      state: 'interrupted', interruption: { reason: 'host-restarted' },
    });
    expect(deriveRunMechanicalAccounting(restored.get(runId)!)).toMatchObject({
      dispatched: 1, settled: 0, cancelled: 0, interrupted: 1,
    });
    expect(renderRunEvidencePack(restored.get(runId)!)).toContain(
      'Interruption: **host-restarted**; last observed 2026-09-11T10:00:00.000Z; detected 2026-09-11T10:05:00.000Z.',
    );
  });

  it('atomically admits a replacement and links the interrupted original as superseded', () => {
    const ledger = new RunLedger();
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'original-handle', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Build it.', originCorrelationId: 'root-replacement', dispatchedAt: '2026-09-11T11:00:00.000Z',
    });
    ledger.reconcileRestoredActiveDelegations('2026-09-11T11:02:00.000Z');

    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'replacement-handle', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Resume from durable inputs.', originCorrelationId: 'root-replacement',
      replacesHandle: 'original-handle', replacementReason: 'Worker continuity was lost.',
      dispatchedAt: '2026-09-11T11:03:00.000Z',
    });

    const run = ledger.get(runId)!;
    expect(run.delegations.find((item) => item.handle === 'replacement-handle')?.state).toBe('active');
    expect(run.delegations.find((item) => item.handle === 'original-handle')).toMatchObject({
      state: 'interrupted',
      dispositions: [{
        disposition: 'superseded', replacementHandle: 'replacement-handle',
        reason: 'Worker continuity was lost.',
      }],
    });
    const afterSuperseded = ledger.snapshot();
    ledger.recordDisposition({
      handle: 'original-handle', agentId: 'dev', outcome: 'no-evidence', disposition: 'abandoned',
      reason: 'This conflicting terminal state must be refused.', recordedAt: '2026-09-11T11:04:00.000Z',
    });
    expect(ledger.snapshot()).toEqual(afterSuperseded);

    const legacyContradiction = structuredClone(afterSuperseded);
    legacyContradiction[0].delegations.find(({ handle }) => handle === 'original-handle')!.dispositions.push({
      handle: 'original-handle', agentId: 'dev', outcome: 'no-evidence', disposition: 'abandoned',
      reason: 'A pre-fix contradictory append.', recordedAt: '2026-09-11T11:04:00.000Z',
    });
    expect(new RunLedger(legacyContradiction).inspectTaskStatus('pm', ['original-handle'])[0]).toMatchObject({
      lifecycle: 'interrupted',
      disposition: { value: 'superseded', replacementHandle: 'replacement-handle' },
    });
  });

  it('keeps a live delegation owned by another window and merges it instead of clobbering it on save', () => {
    const ownerA = { hostInstanceId: 'window-a', epoch: 'host-a-1' };
    const ownerB = { hostInstanceId: 'window-b', epoch: 'host-b-1' };
    const windowA = new RunLedger([], { host: ownerA, ownerLeaseMs: 30_000 });
    const runA = windowA.recordDelegationDispatched({
      coordinatorId: 'pm-a', handle: 'live-a', requestedAgent: 'developer', agentId: 'dev-a',
      instruction: 'Keep working in window A.', originCorrelationId: 'root-a',
      dispatchedAt: '2026-09-11T13:00:00.000Z',
    });
    let sharedSnapshot = windowA.snapshotForPersistence([]);

    const windowB = new RunLedger(sharedSnapshot, { host: ownerB, ownerLeaseMs: 30_000 });
    expect(windowB.reconcileRestoredActiveDelegations('2026-09-11T13:00:05.000Z')).toEqual([]);
    expect(windowB.get(runA)?.delegations[0]).toMatchObject({
      state: 'active', owner: ownerA,
    });

    windowA.recordHostHeartbeat('2026-09-11T13:00:06.000Z');
    sharedSnapshot = windowA.snapshotForPersistence(sharedSnapshot);
    windowB.recordDelegationDispatched({
      coordinatorId: 'pm-b', handle: 'live-b', requestedAgent: 'reviewer', agentId: 'dev-b',
      instruction: 'Work independently in window B.', originCorrelationId: 'root-b',
      dispatchedAt: '2026-09-11T13:00:07.000Z',
    });
    sharedSnapshot = windowB.snapshotForPersistence(sharedSnapshot);

    const persistedA = new RunLedger(sharedSnapshot).get(runA)?.delegations[0];
    expect(persistedA).toMatchObject({
      handle: 'live-a', state: 'active',
      owner: { ...ownerA, heartbeatAt: '2026-09-11T13:00:06.000Z' },
    });
    expect(new RunLedger(sharedSnapshot).snapshot().flatMap((run) => run.delegations.map((item) => item.handle)))
      .toEqual(expect.arrayContaining(['live-a', 'live-b']));
  });

  it('reconciles only an earlier epoch from this window or a demonstrably stale foreign owner', () => {
    const first = new RunLedger([], {
      host: { hostInstanceId: 'window-a', epoch: 'epoch-1' }, ownerLeaseMs: 30_000,
    });
    first.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'same-window', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Owned by the old host epoch.', originCorrelationId: 'root-same-window',
      dispatchedAt: '2026-09-11T14:00:00.000Z',
    });
    const restarted = new RunLedger(first.snapshot(), {
      host: { hostInstanceId: 'window-a', epoch: 'epoch-2' }, ownerLeaseMs: 30_000,
    });
    const sameWindowBranches: string[] = [];
    expect(restarted.reconcileRestoredActiveDelegations(
      '2026-09-11T14:00:01.000Z',
      (decision) => sameWindowBranches.push(decision.branch),
    ))
      .toEqual([expect.objectContaining({ handle: 'same-window', reason: 'host-restarted' })]);
    expect(sameWindowBranches).toEqual(['same-host-older-epoch']);

    const foreign = new RunLedger(first.snapshot(), {
      host: { hostInstanceId: 'window-b', epoch: 'epoch-1' }, ownerLeaseMs: 30_000,
    });
    const foreignBranches: string[] = [];
    expect(foreign.reconcileRestoredActiveDelegations(
      '2026-09-11T14:00:29.999Z',
      (decision) => foreignBranches.push(decision.branch),
    )).toEqual([]);
    expect(foreign.reconcileRestoredActiveDelegations(
      '2026-09-11T14:00:30.000Z',
      (decision) => foreignBranches.push(decision.branch),
    ))
      .toEqual([expect.objectContaining({ handle: 'same-window', reason: 'host-restarted' })]);
    expect(foreignBranches).toEqual(['foreign-owner-lease-active', 'foreign-owner-lease-expired']);
  });

  it('keeps this host own active row when a foreign merge presents a terminal copy first', () => {
    const host = { hostInstanceId: 'window-a', epoch: 'epoch-a' };
    const owned = new RunLedger([], { host });
    const runId = owned.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'owned-live', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Keep working.', originCorrelationId: 'root-owned',
      dispatchedAt: '2026-09-11T15:00:00.000Z',
    });
    const terminalCopy = owned.snapshot();
    terminalCopy[0].delegations[0].state = 'interrupted';
    terminalCopy[0].delegations[0].interruption = {
      reason: 'host-restarted',
      lastObservedAt: '2026-09-11T15:00:00.000Z',
      detectedAt: '2026-09-11T15:01:00.000Z',
    };
    owned.recordHostHeartbeat('2026-09-11T15:01:01.000Z');

    const hostAwareMerge = new RunLedger(terminalCopy, { host });
    hostAwareMerge.snapshotForPersistence(owned.snapshot());

    expect(hostAwareMerge.get(runId)?.delegations[0]).toMatchObject({
      handle: 'owned-live', state: 'active', owner: host,
    });
  });

  it('lets a resumed owner heartbeat repair a foreign interruption recorded while it slept', () => {
    const owner = { hostInstanceId: 'window-a', epoch: 'epoch-a' };
    const observer = { hostInstanceId: 'window-b', epoch: 'epoch-b' };
    const active = new RunLedger([], { host: owner });
    active.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'sleeping-owner', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Resume safely.', originCorrelationId: 'root-sleep',
      dispatchedAt: '2026-09-11T14:00:00.000Z',
    });
    const interrupted = new RunLedger(active.snapshot(), { host: observer, ownerLeaseMs: 30_000 });
    interrupted.reconcileRestoredActiveDelegations('2026-09-11T14:00:30.000Z');
    active.recordHostHeartbeat('2026-09-11T14:00:31.000Z');

    const merged = new RunLedger(interrupted.snapshot(), { host: observer });
    merged.snapshotForPersistence(active.snapshot());
    expect(merged.inspectTaskStatus('pm', ['sleeping-owner'])[0]).toMatchObject({ lifecycle: 'active' });
  });

  it('does not revive a resumed owner after a coordinator superseded its interruption', () => {
    const owner = { hostInstanceId: 'window-a', epoch: 'epoch-a' };
    const observer = { hostInstanceId: 'window-b', epoch: 'epoch-b' };
    const active = new RunLedger([], { host: owner });
    active.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'original', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Original attempt.', originCorrelationId: 'root-superseded',
      dispatchedAt: '2026-09-11T14:00:00.000Z',
    });
    const replacement = new RunLedger(active.snapshot(), { host: observer, ownerLeaseMs: 30_000 });
    replacement.reconcileRestoredActiveDelegations('2026-09-11T14:00:31.000Z');
    replacement.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'replacement', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Replacement attempt.', originCorrelationId: 'root-superseded',
      replacesHandle: 'original', replacementReason: 'The original owner lease expired.',
      dispatchedAt: '2026-09-11T14:00:32.000Z',
    });
    active.recordHostHeartbeat('2026-09-11T14:00:33.000Z');

    for (const host of [undefined, owner, observer]) {
      for (const [first, second] of [
        [replacement.snapshot(), active.snapshot()],
        [active.snapshot(), replacement.snapshot()],
      ] as const) {
        const merged = new RunLedger(first, host ? { host } : undefined);
        merged.snapshotForPersistence(second);
        const delegations = merged.snapshot()[0].delegations;
        expect(delegations.find(({ handle }) => handle === 'original')).toMatchObject({
          state: 'interrupted',
          dispositions: [expect.objectContaining({
            disposition: 'superseded', replacementHandle: 'replacement',
          })],
        });
        expect(delegations.find(({ handle }) => handle === 'replacement')).toMatchObject({ state: 'active' });
      }
    }
  });

  it('retains repeated settled dispositions when their reasons are different', () => {
    const ledger = new RunLedger();
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'repeat-disposition', requestedAgent: 'developer', agentId: 'dev',
      instruction: 'Revise until acceptable.', originCorrelationId: 'root-repeat-disposition',
    });
    ledger.recordDelegationEvidence({
      handle: 'repeat-disposition', agentId: 'dev', outcome: 'verified', evidence,
    });
    ledger.recordDisposition({
      handle: 'repeat-disposition', agentId: 'dev', outcome: 'verified', disposition: 'needs-rework',
      reason: 'No tests.', recordedAt: '2026-09-11T15:00:00.000Z',
    });
    ledger.recordDisposition({
      handle: 'repeat-disposition', agentId: 'dev', outcome: 'verified', disposition: 'needs-rework',
      reason: 'The new test misses the failure path.', recordedAt: '2026-09-11T15:01:00.000Z',
    });

    expect(ledger.snapshot()[0].delegations[0].dispositions).toEqual([
      expect.objectContaining({ disposition: 'needs-rework', reason: 'No tests.' }),
      expect.objectContaining({ disposition: 'needs-rework', reason: 'The new test misses the failure path.' }),
    ]);
  });
});

// F7-23 (v0.9.88 §5.9): a run whose interrupted work was superseded or abandoned closes once, as partial.
describe('RunLedger resolved interrupted runs', () => {
  const host = { hostInstanceId: 'window-1', epoch: 'activation-1' };
  const at = (minute: number) => `2026-09-26T10:${String(minute).padStart(2, '0')}:00.000Z`;
  const dispatch = (ledger: RunLedger, handle: string, origin: string, minute: number, extra: Record<string, unknown> = {}) =>
    ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle, requestedAgent: 'dev', agentId: 'dev', instruction: `Task ${handle}`,
      originCorrelationId: origin, dispatchedAt: at(minute), ...extra,
    });
  const interrupt = (ledger: RunLedger, handle: string, minute: number) => ledger.recordDelegationInterrupted({
    coordinatorId: 'pm', handle, agentId: 'dev', reason: 'worker-lost', lastObservedAt: at(minute), detectedAt: at(minute),
  });
  const run = (ledger: RunLedger, id: string) => ledger.snapshot().find((record) => record.id === id)!;

  it('closes the original run once as partial when its task is replaced from the next request (the field shape)', () => {
    const ledger = new RunLedger([], { host });
    const original = dispatch(ledger, 'h-old', 'origin-a', 0)!;
    interrupt(ledger, 'h-old', 1);
    expect(run(ledger, original).status).toBe('open');

    dispatch(ledger, 'h-new', 'origin-b', 2, { replacesHandle: 'h-old', replacementReason: 'The worker was lost.' });
    expect(run(ledger, original)).toMatchObject({
      status: 'closed', closeoutCompletionState: 'partial', closeoutBasis: 'interrupted-work-resolved', endedAt: at(2),
    });
    // A repeated receipt changes nothing, and the replacement's own run is untouched.
    dispatch(ledger, 'h-new', 'origin-b', 3, { replacesHandle: 'h-old', replacementReason: 'The worker was lost.' });
    expect(run(ledger, original).endedAt).toBe(at(2));
    expect(ledger.snapshot().find((record) => record.id !== original)?.status).toBe('open');
  });

  it('waits while another task in the run is still working, and closes when that task is later cancelled', () => {
    const ledger = new RunLedger([], { host });
    const original = dispatch(ledger, 'h-old', 'origin-a', 0)!;
    dispatch(ledger, 'h-other', 'origin-a', 0);
    interrupt(ledger, 'h-old', 1);
    dispatch(ledger, 'h-new', 'origin-b', 2, { replacesHandle: 'h-old', replacementReason: 'The worker was lost.' });
    expect(run(ledger, original).status).toBe('open');

    ledger.recordDelegationCancelled({ coordinatorId: 'pm', handle: 'h-other', agentId: 'dev', reason: 'owner stopped it', cancelledAt: at(4) });
    expect(run(ledger, original)).toMatchObject({ status: 'closed', closeoutBasis: 'interrupted-work-resolved', endedAt: at(4) });
  });

  // Field test, 2026-09-26: the user pressed Stop on a working delegate (cancelled, which replaces_handle refuses),
  // then asked the PM to redo it; the PM dispatched a new task from the next request and the old run stayed open.
  it('closes a run whose task the user stopped once the coordinator dispatches from the next request', () => {
    const ledger = new RunLedger([], { host });
    const original = dispatch(ledger, 'h-old', 'origin-a', 0)!;
    ledger.recordDelegationCancelled({ coordinatorId: 'pm', handle: 'h-old', agentId: 'dev', reason: 'Stopped by user.', cancelledAt: at(1) });
    expect(run(ledger, original).status).toBe('open');

    dispatch(ledger, 'h-new', 'origin-b', 2);
    expect(run(ledger, original)).toMatchObject({
      status: 'closed', closeoutCompletionState: 'partial', closeoutBasis: 'stopped-work-resolved', endedAt: at(2),
    });
    dispatch(ledger, 'h-later', 'origin-c', 3);
    expect(run(ledger, original).endedAt).toBe(at(2));
  });

  it('closes a stopped run when the coordinator answers another request, and keeps it open until then', () => {
    const ledger = new RunLedger([], { host });
    const original = dispatch(ledger, 'h-old', 'origin-a', 0)!;
    ledger.recordDelegationCancelled({ coordinatorId: 'pm', handle: 'h-old', agentId: 'dev', reason: 'Stopped by user.', cancelledAt: at(1) });
    // The coordinator may still be working in this run: nothing proves it left.
    expect(run(ledger, original).status).toBe('open');
    ledger.observeMessage({
      id: 'reply', correlationId: 'origin-z', from: 'pm', to: 'user', type: 'task.complete', priority: 'normal',
      payload: { instruction: 'Answered the next request.' }, timestamp: at(3),
    } as never);
    expect(run(ledger, original)).toMatchObject({ status: 'closed', closeoutBasis: 'stopped-work-resolved', endedAt: at(3) });
  });

  // v0.9.93 (the Owner's decision after the field smoke of 2026-10-04): a stop that leaves nothing running ends the
  // job at the stop when the coordinator is idle, under the coordinator's last reply in that job.
  describe('a stop while the coordinator is idle', () => {
    const idle = { host, activeTurnId: () => undefined };
    const reply = (ledger: RunLedger, correlationId: string, minute: number, turnId?: string) => ledger.observeMessage({
      id: `reply-${correlationId}-${minute}`, correlationId, from: 'pm', to: 'user', type: 'task.complete', priority: 'normal',
      payload: { instruction: 'Dispatched. I will report back.', ...(turnId ? { metadata: { turnId } } : {}) }, timestamp: at(minute),
    } as never);
    const stop = (ledger: RunLedger, handle: string, minute: number) => ledger.recordDelegationCancelled({
      coordinatorId: 'pm', handle, agentId: 'dev', reason: 'Stopped by user.', cancelledAt: at(minute),
    });
    const settle = (ledger: RunLedger, handle: string) => ledger.recordDelegationEvidence({
      handle, agentId: 'dev', outcome: 'tool-activity-recorded',
      evidence: { outcome: 'tool-activity-recorded', changedFiles: [], hadToolActions: true, verification: { ran: false, passed: false }, unrecordedWrites: false },
    });

    it('closes the job at the stop, as partial, under the coordinator\'s last reply in it', () => {
      const ledger = new RunLedger([], idle);
      const original = dispatch(ledger, 'h-1', 'origin-a', 0, { originTurnId: 'turn-dispatch' })!;
      reply(ledger, 'origin-a', 1, 'turn-dispatch');
      // The reply cannot close the run: its task is running.
      expect(run(ledger, original).status).toBe('open');
      stop(ledger, 'h-1', 2);
      expect(run(ledger, original)).toMatchObject({
        status: 'closed', closeoutCompletionState: 'partial', closeoutBasis: 'stopped-work-resolved',
        endedAt: at(2), closingTurnId: 'turn-dispatch',
      });
      expect(ledger.closedRunAnchorFacts()).toEqual([
        { runId: original, coordinatorId: 'pm', closingTurnId: 'turn-dispatch', endedAt: at(2) },
      ]);
      // What the coordinator does afterwards does not move the close or its place.
      reply(ledger, 'origin-z', 3, 'turn-elsewhere');
      expect(run(ledger, original)).toMatchObject({ endedAt: at(2), closingTurnId: 'turn-dispatch' });
    });

    it('takes the latest reply of the run when the coordinator replied more than once', () => {
      const ledger = new RunLedger([], idle);
      const original = dispatch(ledger, 'h-1', 'origin-a', 0)!;
      reply(ledger, 'origin-a', 1, 'turn-first');
      reply(ledger, original, 2, 'turn-woken');
      stop(ledger, 'h-1', 3);
      expect(run(ledger, original)).toMatchObject({ status: 'closed', closingTurnId: 'turn-woken' });
    });

    it('leaves the job to the coordinator while the coordinator is in a turn', () => {
      const ledger = new RunLedger([], { host, activeTurnId: () => 'turn-busy' });
      const original = dispatch(ledger, 'h-1', 'origin-a', 0)!;
      reply(ledger, 'origin-a', 1, 'turn-dispatch');
      stop(ledger, 'h-1', 2);
      expect(run(ledger, original).status).toBe('open');
      // Its own reply in the run then closes it. The task was stopped all the same, so the run is partial whether
      // the host or the coordinator closed it; only the host's close carries a basis.
      reply(ledger, 'origin-a', 3, 'turn-close');
      expect(run(ledger, original)).toMatchObject({ status: 'closed', closeoutCompletionState: 'partial', closingTurnId: 'turn-close' });
      expect(run(ledger, original).closeoutBasis).toBeUndefined();
    });

    it('closes a job complete when its coordinator replies complete and nothing was stopped or interrupted', () => {
      const ledger = new RunLedger([], { host, activeTurnId: () => 'turn-busy' });
      const original = dispatch(ledger, 'h-1', 'origin-a', 0)!;
      dispatch(ledger, 'h-2', 'origin-a', 0);
      settle(ledger, 'h-1');
      settle(ledger, 'h-2');
      reply(ledger, 'origin-a', 3, 'turn-close');
      expect(run(ledger, original)).toMatchObject({ status: 'closed', closeoutCompletionState: 'complete' });

      // One stopped task among settled ones is enough.
      const mixed = new RunLedger([], { host, activeTurnId: () => 'turn-busy' });
      const second = dispatch(mixed, 'h-1', 'origin-a', 0)!;
      dispatch(mixed, 'h-2', 'origin-a', 0);
      settle(mixed, 'h-1');
      stop(mixed, 'h-2', 2);
      reply(mixed, 'origin-a', 3, 'turn-close');
      expect(run(mixed, second)).toMatchObject({ status: 'closed', closeoutCompletionState: 'partial' });
    });

    it('stays open while another task runs, and while a settled result has not reached the coordinator', () => {
      const ledger = new RunLedger([], idle);
      const original = dispatch(ledger, 'h-1', 'origin-a', 0)!;
      dispatch(ledger, 'h-2', 'origin-a', 0);
      dispatch(ledger, 'h-3', 'origin-a', 0);
      reply(ledger, 'origin-a', 1, 'turn-dispatch');
      stop(ledger, 'h-1', 2);
      expect(run(ledger, original).status).toBe('open');
      settle(ledger, 'h-2');
      stop(ledger, 'h-3', 3);
      // The coordinator will be woken with h-2's result, and its reply to that is the run's own closeout.
      expect(run(ledger, original).status).toBe('open');

      const delivered = new RunLedger([], idle);
      const second = dispatch(delivered, 'h-2', 'origin-a', 0)!;
      dispatch(delivered, 'h-3', 'origin-a', 0);
      reply(delivered, 'origin-a', 1, 'turn-dispatch');
      settle(delivered, 'h-2');
      delivered.recordDeliveryDelivered('h-2', 'auto-wake', at(2));
      stop(delivered, 'h-3', 3);
      expect(run(delivered, second)).toMatchObject({ status: 'closed', closeoutBasis: 'stopped-work-resolved', endedAt: at(3), closingTurnId: 'turn-dispatch' });
    });

    it('guesses no closing turn: without a placeable reply of the coordinator in the run, the older rule closes it later', () => {
      const ledger = new RunLedger([], idle);
      const original = dispatch(ledger, 'h-1', 'origin-a', 0)!;
      stop(ledger, 'h-1', 1);
      expect(run(ledger, original).status).toBe('open');
      reply(ledger, 'origin-z', 2, 'turn-elsewhere');
      expect(run(ledger, original)).toMatchObject({ status: 'closed', closeoutBasis: 'stopped-work-resolved', endedAt: at(2), closingTurnId: 'turn-elsewhere' });

      const untagged = new RunLedger([], idle);
      const second = dispatch(untagged, 'h-1', 'origin-a', 0)!;
      reply(untagged, 'origin-a', 1);
      stop(untagged, 'h-1', 2);
      expect(run(untagged, second).status).toBe('open');
    });

    it('does not act for a ledger that cannot tell whether the coordinator is in a turn', () => {
      const ledger = new RunLedger([], { host });
      const original = dispatch(ledger, 'h-1', 'origin-a', 0)!;
      reply(ledger, 'origin-a', 1, 'turn-dispatch');
      stop(ledger, 'h-1', 2);
      expect(run(ledger, original).status).toBe('open');
    });

    // Field smoke, 2026-10-04: the worker compacted its context for 47 s before it admitted the task. The dispatch
    // receipt, and with it the run, came after the coordinator's dispatching turn and reply.
    it('gives a run that opens late the turn and the reply that came before it, by exact agent and thread', () => {
      const timing = {
        startedAt: '2026-09-26T09:59:30.000Z', settledAt: '2026-09-26T09:59:50.000Z', durationMs: 20_000, approvalWaitMs: 0,
        phases: {
          queuedMs: 0, hostMs: 1_000, providerWaitMs: 10_000, reasoningMs: 2_000, respondingMs: 3_000, toolMs: 4_000,
          providerWaitCount: 1, longestProviderWaitMs: 10_000,
        },
      };
      const ledger = new RunLedger([], idle);
      // No run holds the thread yet, so the ledger keeps nothing in a run and says so.
      expect(ledger.recordTurn('pm', { turnId: 'turn-dispatch', correlationId: 'origin-a', usageUnitId: 'unit-1', ended: 'completed', timing })).toBe(false);
      ledger.recordTurn('pm', { turnId: 'turn-elsewhere', correlationId: 'origin-other', ended: 'completed', timing });
      ledger.recordTurn('dev', { turnId: 'turn-dev', correlationId: 'origin-a', ended: 'completed', timing });
      reply(ledger, 'origin-a', 0, 'turn-dispatch');
      expect(ledger.snapshot()).toEqual([]);

      const original = dispatch(ledger, 'h-1', 'origin-a', 1, { originTurnId: 'turn-dispatch' })!;
      expect(run(ledger, original).openingTurnId).toBe('turn-dispatch');
      // Only the coordinator's turn on the run's own thread: not its turn on another thread, not another agent's.
      expect(run(ledger, original).turns).toEqual([
        expect.objectContaining({ state: 'recorded', runId: original, turnId: 'turn-dispatch', agentId: 'pm', correlationId: 'origin-a', usageUnitId: 'unit-1' }),
      ]);
      // The reply that came before the run is the coordinator's last reply in it.
      stop(ledger, 'h-1', 2);
      expect(run(ledger, original)).toMatchObject({ status: 'closed', closeoutBasis: 'stopped-work-resolved', closingTurnId: 'turn-dispatch' });

      // Taken once: a later run on the same thread does not get the turn again, and another thread's run gets its own.
      const again = dispatch(ledger, 'h-2', 'origin-a', 3)!;
      expect(run(ledger, again).turns).toEqual([]);
      const other = dispatch(ledger, 'h-3', 'origin-other', 4)!;
      expect(run(ledger, other).turns).toEqual([expect.objectContaining({ turnId: 'turn-elsewhere', runId: other })]);
    });
  });

  it('never host-closes a run whose tasks all settled normally, even after the coordinator moved on', () => {
    const ledger = new RunLedger([], { host });
    const original = dispatch(ledger, 'h-done', 'origin-a', 0)!;
    ledger.recordDelegationEvidence({
      handle: 'h-done', agentId: 'dev', outcome: 'tool-activity-recorded',
      evidence: { outcome: 'tool-activity-recorded', changedFiles: [], hadToolActions: true, verification: { ran: false, passed: false }, unrecordedWrites: false },
    });
    dispatch(ledger, 'h-next', 'origin-b', 2);
    expect(run(ledger, original).status).toBe('open');
  });

  it('says in the evidence pack which host closeout it was, and never calls it complete', () => {
    const ledger = new RunLedger([], { host });
    const original = dispatch(ledger, 'h-old', 'origin-a', 0)!;
    ledger.recordDelegationCancelled({ coordinatorId: 'pm', handle: 'h-old', agentId: 'dev', reason: 'Stopped by user.', cancelledAt: at(1) });
    dispatch(ledger, 'h-new', 'origin-b', 2);
    const pack = renderRunEvidencePack(run(ledger, original), at(5));
    expect(pack).toContain('- Status: **PARTIAL**');
    expect(pack).toContain('a task in this run was stopped before it finished, the coordinator was idle or had moved on, and no work remains');
    expect(pack).not.toContain('every interrupted task was superseded or abandoned');
  });

  it('keeps the stopped-work basis through persistence', () => {
    const ledger = new RunLedger([], { host });
    const original = dispatch(ledger, 'h-old', 'origin-a', 0)!;
    ledger.recordDelegationCancelled({ coordinatorId: 'pm', handle: 'h-old', agentId: 'dev', reason: 'Stopped by user.', cancelledAt: at(1) });
    dispatch(ledger, 'h-new', 'origin-b', 2);
    const restored = new RunLedger(ledger.snapshot());
    expect(restored.snapshot().find((record) => record.id === original)).toMatchObject({ status: 'closed', closeoutBasis: 'stopped-work-resolved' });
  });

  it('leaves a same-run replacement to the run\'s own closeout, which records partial with no host basis', () => {
    const ledger = new RunLedger([], { host });
    const original = dispatch(ledger, 'h-old', 'origin-a', 0)!;
    interrupt(ledger, 'h-old', 1);
    dispatch(ledger, 'h-new', 'origin-a', 2, { replacesHandle: 'h-old', replacementReason: 'Retry in this turn.' });
    expect(run(ledger, original).status).toBe('open');

    ledger.recordDelegationEvidence({
      handle: 'h-new', agentId: 'dev', outcome: 'tool-activity-recorded',
      evidence: { outcome: 'tool-activity-recorded', changedFiles: [], hadToolActions: true, verification: { ran: false, passed: false }, unrecordedWrites: false },
    });
    ledger.observeMessage({
      id: 'closeout', correlationId: 'origin-a', from: 'pm', to: 'user', type: 'task.complete', priority: 'normal',
      payload: { instruction: 'Done after the retry.' }, timestamp: at(5),
    } as never);
    expect(run(ledger, original)).toMatchObject({ status: 'closed', closeoutCompletionState: 'partial' });
    expect(run(ledger, original).closeoutBasis).toBeUndefined();
  });

  it('closes an abandoned run once the coordinator ends a turn elsewhere, even when the decision comes later', () => {
    const ledger = new RunLedger();
    const original = dispatch(ledger, 'h-old', 'origin-a', 0)!;
    interrupt(ledger, 'h-old', 1);
    // The coordinator answers the next request first; the abandoned decision is recorded afterwards.
    ledger.observeMessage({
      id: 'reply', correlationId: 'origin-z', from: 'pm', to: 'user', type: 'task.complete', priority: 'normal',
      payload: { instruction: 'Started something else.' }, timestamp: at(3),
    } as never);
    expect(run(ledger, original).status).toBe('open');
    ledger.recordDisposition({
      handle: 'h-old', agentId: 'dev', outcome: 'no-evidence', disposition: 'abandoned',
      reason: 'No longer needed.', recordedAt: at(4),
    });
    expect(run(ledger, original)).toMatchObject({ status: 'closed', closeoutBasis: 'interrupted-work-resolved', endedAt: at(4) });
  });

  it('never takes another window\'s newer run as proof, and does after this host dispatches one', () => {
    const ledger = new RunLedger([], { host });
    const original = dispatch(ledger, 'h-old', 'origin-a', 0)!;
    interrupt(ledger, 'h-old', 1);
    ledger.recordDisposition({
      handle: 'h-old', agentId: 'dev', outcome: 'no-evidence', disposition: 'superseded',
      reason: 'Replaced in the other window.', replacementHandle: 'h-foreign', recordedAt: at(2),
    });
    const otherWindow = new RunLedger([], { host: { hostInstanceId: 'window-2', epoch: 'activation-9' } });
    otherWindow.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'h-foreign', requestedAgent: 'dev', agentId: 'dev', instruction: 'Other window.',
      originCorrelationId: 'origin-foreign', dispatchedAt: at(3),
    });
    ledger.snapshotForPersistence(otherWindow.snapshot());
    expect(run(ledger, original).status).toBe('open');

    dispatch(ledger, 'h-local', 'origin-c', 5);
    expect(run(ledger, original)).toMatchObject({ status: 'closed', closeoutBasis: 'interrupted-work-resolved' });
  });

  it('keeps the host basis through persistence and drops it from a run that is not closed', () => {
    const ledger = new RunLedger([], { host });
    const original = dispatch(ledger, 'h-old', 'origin-a', 0)!;
    interrupt(ledger, 'h-old', 1);
    dispatch(ledger, 'h-new', 'origin-b', 2, { replacesHandle: 'h-old', replacementReason: 'Lost.' });
    const reloaded = new RunLedger(JSON.parse(JSON.stringify(ledger.snapshot())));
    expect(reloaded.get(original)?.closeoutBasis).toBe('interrupted-work-resolved');
    const forged = JSON.parse(JSON.stringify(ledger.snapshot()));
    forged[0].status = 'open';
    expect(new RunLedger(forged).get(original)?.closeoutBasis).toBeUndefined();
  });
});

describe('v0.9.91 turn outcome receipts in the run ledger', () => {
  const receiptFor = (turnId: string, agentId: string, runId: string | undefined, refused = 0): TurnOutcomeReceiptV1 => {
    const turn = new TurnOutcomeAccumulator();
    for (let index = 0; index < refused; index++) {
      turn.use(`call-${index}`);
      turn.result(`call-${index}`, { status: 'refused', observedBy: 'host', reason: 'consent' });
    }
    return turn.finish({
      turnId, agentId, ...(runId ? { runId } : {}), recordedAt: '2026-09-30T10:00:00.000Z', delivery: { kind: 'reply' },
    })!;
  };
  const terminal = (from: string, to: string, correlationId: string, turnOutcome: unknown, type: Message['type'] = 'task.complete') => {
    const sent = message(from, to, type, 'Done.', correlationId);
    sent.payload.metadata = { turnOutcome };
    return sent;
  };
  const dispatched = (ledger: RunLedger) => ledger.recordDelegationDispatched({
    coordinatorId: 'pm', handle: 'h-dev', requestedAgent: 'dev', agentId: 'dev', instruction: 'Do it.', originCorrelationId: 'root',
  });

  it('keeps worker and coordinator receipts in the run the host resolved, before the closeout closes it', () => {
    const ledger = new RunLedger();
    const runId = dispatched(ledger);
    expect(ledger.turnRunId('dev', 'h-dev')).toBe(runId);
    expect(ledger.turnRunId('pm', 'root')).toBe(runId);
    // Membership is the run's own thread or delegation, never an agent id alone.
    expect(ledger.turnRunId('dev', 'root')).toBeUndefined();
    expect(ledger.turnRunId('qa', 'h-dev')).toBeUndefined();

    // The worker's turn had a refused tool: an intermediate fact that cannot change the run's lifecycle.
    const worker = receiptFor('m-dev', 'dev', runId, 1);
    ledger.observeMessage(terminal('dev', 'pm', 'h-dev', worker));
    ledger.recordDelegationEvidence({ handle: 'h-dev', agentId: 'dev', outcome: 'verified', evidence });
    const coordinator = receiptFor('m-pm', 'pm', runId);
    ledger.observeMessage(terminal('pm', 'user', 'root', coordinator));

    const run = ledger.get(runId)!;
    expect(run.status).toBe('closed');
    expect(run.turnOutcomes).toEqual([
      { state: 'available', receipt: worker },
      { state: 'available', receipt: coordinator },
    ]);
    // Stored, never read as control state: the closeout is the coordinator's reply, not the receipt.
    expect(run.closeoutCompletionState).toBe('complete');
  });

  it('keeps the receipt a worker-lost error carries, so a dead worker turn is recorded, not missing', () => {
    const ledger = new RunLedger();
    const runId = dispatched(ledger);
    const lost = receiptFor('m-lost', 'dev', runId);
    ledger.observeMessage(terminal('dev', 'pm', 'h-dev', lost, 'system.error'));
    expect(ledger.get(runId)!.turnOutcomes).toEqual([{ state: 'available', receipt: lost }]);
  });

  it('keeps no receipt that names another run, another agent, or no run, or arrives on a thread the run does not own', () => {
    const ledger = new RunLedger();
    const runId = dispatched(ledger);
    ledger.observeMessage(terminal('dev', 'pm', 'h-dev', receiptFor('m-1', 'dev', 'other-run')));
    ledger.observeMessage(terminal('dev', 'pm', 'h-dev', receiptFor('m-2', 'qa', runId)));
    ledger.observeMessage(terminal('dev', 'pm', 'h-dev', receiptFor('m-3', 'dev', undefined)));
    ledger.observeMessage(terminal('dev', 'pm', 'unrelated-thread', receiptFor('m-4', 'dev', runId)));
    ledger.observeMessage(terminal('dev', 'pm', 'h-dev', { forged: true }));
    expect(ledger.get(runId)!.turnOutcomes).toEqual([]);
  });

  it('turns a different receipt under the same id into a sticky conflict that no later write resolves', () => {
    const ledger = new RunLedger();
    const runId = dispatched(ledger);
    const first = receiptFor('m-dev', 'dev', runId);
    const other = receiptFor('m-dev', 'dev', runId, 1);
    ledger.observeMessage(terminal('dev', 'pm', 'h-dev', first));
    ledger.observeMessage(terminal('dev', 'pm', 'h-dev', first));
    expect(ledger.get(runId)!.turnOutcomes).toEqual([{ state: 'available', receipt: first }]);
    ledger.observeMessage(terminal('dev', 'pm', 'h-dev', other));
    ledger.observeMessage(terminal('dev', 'pm', 'h-dev', first));
    expect(ledger.get(runId)!.turnOutcomes).toEqual([
      // The conflict's time comes from the receipts, never from when or where it was merged.
      { state: 'conflict', receiptId: 'turn-outcome:m-dev', observedAt: '2026-09-30T10:00:00.000Z' },
    ]);
  });

  it('merges another window by receipt id: union for new ids, conflict for unequal copies', () => {
    const local = new RunLedger();
    const runId = dispatched(local);
    const shared = receiptFor('m-shared', 'dev', runId);
    local.observeMessage(terminal('dev', 'pm', 'h-dev', shared));
    const external = structuredClone(local.snapshot());
    external[0].turnOutcomes.push({ state: 'available', receipt: receiptFor('m-other-window', 'dev', runId) });
    external[0].turnOutcomes[0] = { state: 'available', receipt: receiptFor('m-shared', 'dev', runId, 2) };

    const merged = local.snapshotForPersistence(external).find((run) => run.id === runId)!;
    expect(merged.turnOutcomes.map((entry) => [entry.state, entry.state === 'available' ? entry.receipt.receiptId : entry.receiptId]))
      .toEqual([['available', 'turn-outcome:m-other-window'], ['conflict', 'turn-outcome:m-shared']]);
    // Merging the same copies again changes nothing: the conflict and its time are stable.
    expect(local.snapshotForPersistence(external).find((run) => run.id === runId)!.turnOutcomes).toEqual(merged.turnOutcomes);
  });

  it('converges on one conflict when two windows hold different receipts under one id, merged in either direction', () => {
    const left = new RunLedger();
    const runId = dispatched(left);
    const right = new RunLedger(left.snapshot());
    const later = { ...receiptFor('m-split', 'dev', runId, 1), recordedAt: '2026-09-30T11:00:00.000Z' };
    left.observeMessage(terminal('dev', 'pm', 'h-dev', receiptFor('m-split', 'dev', runId)));
    right.observeMessage(terminal('dev', 'pm', 'h-dev', later));
    const leftCopy = left.snapshot();
    const rightCopy = right.snapshot();

    const leftThenRight = new RunLedger(leftCopy).snapshotForPersistence(rightCopy).find((run) => run.id === runId)!;
    const rightThenLeft = new RunLedger(rightCopy).snapshotForPersistence(leftCopy).find((run) => run.id === runId)!;
    expect(leftThenRight.turnOutcomes).toEqual([
      { state: 'conflict', receiptId: 'turn-outcome:m-split', observedAt: '2026-09-30T10:00:00.000Z' },
    ]);
    expect(rightThenLeft).toEqual(leftThenRight);
    // A third window holding either receipt, merged in any order, reaches the same conflict.
    expect(new RunLedger(rightCopy).snapshotForPersistence([leftThenRight]).find((run) => run.id === runId)!.turnOutcomes)
      .toEqual(leftThenRight.turnOutcomes);
  });

  it('converges: two windows with disjoint receipts merge to the same entries in either direction, and again', () => {
    const left = new RunLedger();
    const runId = dispatched(left);
    const right = new RunLedger(left.snapshot());
    for (let index = 0; index < 250; index++) {
      const window = index % 2 === 0 ? left : right;
      window.observeMessage(terminal('dev', 'pm', 'h-dev', receiptFor(`m-${index}`, 'dev', runId)));
    }
    // Replaying a terminal message changes nothing, however many receipts the run holds.
    const replayed = terminal('dev', 'pm', 'h-dev', receiptFor('m-249', 'dev', runId));
    right.observeMessage(replayed);
    right.observeMessage(replayed);
    const leftCopy = left.snapshot();
    const rightCopy = right.snapshot();

    const leftThenRight = new RunLedger(leftCopy).snapshotForPersistence(rightCopy).find((run) => run.id === runId)!;
    const rightThenLeft = new RunLedger(rightCopy).snapshotForPersistence(leftCopy).find((run) => run.id === runId)!;
    expect(leftThenRight.turnOutcomes).toHaveLength(250);
    expect(rightThenLeft.turnOutcomes).toEqual(leftThenRight.turnOutcomes);
    expect(leftThenRight.droppedTurnOutcomes).toBe(0);

    const again = new RunLedger([leftThenRight]);
    const twice = again.snapshotForPersistence([rightThenLeft]);
    expect(again.snapshotForPersistence(twice).find((run) => run.id === runId)).toEqual(leftThenRight);
  });

  it('counts stored entries that fail validation once, however often the copies are merged', () => {
    const ledger = new RunLedger();
    const runId = dispatched(ledger);
    ledger.observeMessage(terminal('dev', 'pm', 'h-dev', receiptFor('m-ok', 'dev', runId)));
    const stored = structuredClone(ledger.get(runId)!) as StoredRunRecord;
    (stored.turnOutcomes as unknown[]).push({ state: 'available', receipt: { schemaVersion: 1, receiptId: 'bad' } }, { state: 'mystery' });

    const restored = new RunLedger([stored]);
    expect(restored.get(runId)!.turnOutcomes).toHaveLength(1);
    expect(restored.get(runId)!.droppedTurnOutcomes).toBe(2);
    // The same stored copy merged again, or a second window restoring it, still counts the two entries once.
    restored.snapshotForPersistence([stored]);
    const merged = restored.snapshotForPersistence(new RunLedger([stored]).snapshot());
    expect(merged.find((run) => run.id === runId)!.droppedTurnOutcomes).toBe(2);
  });
});
