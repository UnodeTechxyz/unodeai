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
    expect(portable).toMatchObject({ version: 'portable-run-evidence/3', closeoutCompletionState: 'partial' });
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
    ledger.recordContextManifest('pm', createTurnContextManifest([{
      kind: 'repository-instruction', label: 'AGENTS.md', location: 'AGENTS.md', text: 'Use focused tests.', reason: 'repository instruction',
    }]), root.id);
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
  it('round-trips a v7 partial closeout through the field whitelist', () => {
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
    expect(restored).toMatchObject({ schemaVersion: 7, status: 'closed', closeoutCompletionState: 'partial' });
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
    expect(restored).toMatchObject({ schemaVersion: 7, closeoutCompletionState: 'complete' });
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
    expect(restored.schemaVersion).toBe(7);
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

  it('normalizes both v1 and v7 stored rows to the same total in-memory arrays', () => {
    const ledger = new RunLedger();
    const runId = ledger.recordDelegationDispatched({
      coordinatorId: 'pm', handle: 'legacy-shape', requestedAgent: 'developer', agentId: 'developer',
      instruction: 'Inspect the stored shape.',
    });
    const v7 = ledger.get(runId)!;
    const v1: StoredRunRecord = structuredClone(v7);
    v1.schemaVersion = 1;
    delete v1.outcomeRepairs;
    delete v1.verdicts;
    delete v1.contentReceipts;
    delete v1.reviewObservations;

    const restored = new RunLedger([v1, v7]).snapshot();
    expect(RUN_SCHEMA_VERSIONS).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const run of restored) {
      expect(run.outcomeRepairs).toEqual([]);
      expect(run.verdicts).toEqual([]);
      expect(run.contentReceipts).toEqual([]);
      expect(run.reviewObservations).toEqual([]);
    }

    const unsupported = { ...v7, schemaVersion: 8 } as unknown as StoredRunRecord;
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
});
