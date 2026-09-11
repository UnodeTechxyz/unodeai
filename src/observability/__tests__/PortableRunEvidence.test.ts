import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import {
  PORTABLE_EXCLUSIONS,
  PORTABLE_SCHEMA_FIELDS,
  PORTABLE_UNAVAILABLE,
  buildPortableRunEvidence,
  isPortableRelativePath,
  renderPortableRunEvidence,
} from '../PortableRunEvidence';
import { RUN_RECORD_FIELDS, type RunRecord } from '../RunLedger';

/** Distinctive strings, so a leak is unmistakable rather than a judgement call. */
const OBJECTIVE = 'SECRET-OBJECTIVE-migrate the billing table before the audit';
const INSTRUCTION = 'SECRET-INSTRUCTION-rewrite src/billing.ts and drop the legacy column';
const REFUSAL = 'SECRET-REFUSAL-no teammate "legal-counsel"';
const PERMISSION_LABEL = 'SECRET-LABEL-npm run deploy -- --token=abc123';
const DISPOSITION_REASON = 'SECRET-DISPOSITION-the migration was not reversible';
// A model types this into dispatch_task; nothing constrains it to a configured agent name.
const REQUESTED_AGENT = 'SECRET-REQUESTED-AGENT-the one who knows about /home/ceo/acquisition';
// A verify command carries whatever the user configured, up to and including a token.
const VERIFY_COMMAND = 'SECRET-COMMAND-npm test -- --reporter=/Users/me/co --token=abc123';
// A configured agent id is whatever the user typed. The team-file schema only requires a non-empty string,
// so these are legal ids, and the first version of this format wrote them out unchanged.
const COORDINATOR_ID = 'SECRET-AGENT-ID-project-x-acquisition-lead';
const DELEGATE_ID = 'SECRET-AGENT-ID-counsel-for-the-SECRET-MERGER';
const APPROVER_ID = 'local:SECRET-MACHINE-ID-0123456789';
const UNRESOLVED_ITEM = 'SECRET-UNRESOLVED-item prose must never leave the ledger';
const PRIVATE_GATEWAY = 'https://SECRET-private-gateway.corp.example/v1';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function oneFileDigest(path: string, before: string | null, after: string | null) {
  const file = {
    path,
    beforeContentHash: before === null ? null : sha256(before),
    afterContentHash: after === null ? null : sha256(after),
  };
  return {
    algorithm: 'sha256' as const,
    value: sha256(JSON.stringify([file.path, file.beforeContentHash, file.afterContentHash])),
    files: [file],
  };
}

function runWithEverything(): RunRecord {
  return {
    schemaVersion: 3,
    id: 'run-1',
    coordinatorId: COORDINATOR_ID,
    correlationIds: ['corr-1'],
    status: 'closed',
    startedAt: '2026-08-19T10:00:00.000Z',
    endedAt: '2026-08-19T10:40:00.000Z',
    objective: OBJECTIVE,
    delegations: [{
      handle: 'h1',
      requestedAgent: REQUESTED_AGENT,
      agentId: DELEGATE_ID,
        instruction: INSTRUCTION,
        verificationPlan: { sensors: ['recorded-file-effect', 'run-checks'], noneApplies: 'report-no-applicable-sensor' },
      dispatchedAt: '2026-08-19T10:01:00.000Z',
      state: 'settled',
      temporaryScope: { readGrants: 2, readwriteGrants: 1, appliedAt: '2026-08-19T10:01:05.000Z' },
      route: {
        routeId: 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        connectionKind: 'openai-compatible',
        executionDomain: PRIVATE_GATEWAY,
        privacyDomain: { id: `unresolved-user-selected:${PRIVATE_GATEWAY}|SECRET-model`, status: 'unresolved-user-selected' },
      },
      evidence: {
        outcome: 'verified',
        changedFiles: ['src/billing.ts', 'C:\\Users\\someone\\private\\notes.md', '/etc/passwd', '../outside.ts'],
        hadToolActions: true,
        verification: { ran: true, passed: true, command: VERIFY_COMMAND },
        unrecordedWrites: false,
        verificationPlan: { sensors: ['recorded-file-effect', 'run-checks'], noneApplies: 'report-no-applicable-sensor' },
        verificationPlanStatus: 'satisfied',
        verificationSensors: [
          { kind: 'recorded-file-effect', status: 'passed' },
          { kind: 'run-checks', status: 'passed' },
        ],
      },
      progress: {
        schemaVersion: 1,
        correlationId: 'corr-1',
        agentId: DELEGATE_ID,
        backend: 'openai-compat',
        model: 'gateway-model',
        startedAt: '2026-08-19T10:01:00.000Z',
        settledAt: '2026-08-19T10:20:00.000Z',
        durationMs: 1_140_000,
        modelRequests: 4,
        toolCalls: 17,
        inputTokens: 120_000,
        inputTokensEstimated: true,
        fingerprintSequence: [],
        droppedFingerprintCount: 0,
        materialProgressCount: 6,
        lastMaterialProgressAt: '2026-08-19T10:18:00.000Z',
        longestNoMaterialProgressMs: 120_000,
        outcome: 'framework-evidenced-output',
        hasFinalReply: true,
        terminalState: 'completed',
      },
      dispositions: [{
        handle: 'h1',
        agentId: DELEGATE_ID,
        disposition: 'accepted',
        reason: DISPOSITION_REASON,
        recordedAt: '2026-08-19T10:25:00.000Z',
        outcome: 'verified',
      }],
    }],
    refusedDispatches: [{ requestedAgent: 'legal-counsel', reason: REFUSAL, recordedAt: '2026-08-19T10:02:00.000Z' }],
    permissions: [{
      kind: 'command-approval', agentId: DELEGATE_ID, decision: 'allowed',
      recordedAt: '2026-08-19T10:05:00.000Z', label: PERMISSION_LABEL, approverId: APPROVER_ID,
    }],
    outcomeRepairs: [],
    verdicts: [],
    contextReceipts: [],
    contentReceipts: [],
    reviewObservations: [],
    activity: [],
    droppedActivityItems: 0,
  } as unknown as RunRecord;
}

/**
 * Eight hard exclusions: raw prompt, task title, source bytes, absolute paths, environment values,
 * credentials, tool payloads, full command output. Every one is free text or file content, which is why the
 * format carries no prose at all rather than redacting it: a redactor has to recognise a secret to remove
 * it, and this artifact is meant for a reader outside the organisation.
 */
describe('Portable Run Evidence carries no prose', () => {
  it('leaks nothing a redactor would have had to recognise', () => {
    const rendered = renderPortableRunEvidence(runWithEverything(), '2026-08-19T11:00:00.000Z');

    for (const secret of [
      OBJECTIVE, INSTRUCTION, REFUSAL, PERMISSION_LABEL, DISPOSITION_REASON, REQUESTED_AGENT, VERIFY_COMMAND,
      // The canaries the earlier version of this file never placed: it only marked fields the format was
      // already dropping, so it could not have caught a field the format was keeping.
      COORDINATOR_ID, DELEGATE_ID, APPROVER_ID, PRIVATE_GATEWAY,
    ]) {
      expect(rendered).not.toContain(secret);
    }
    // The marker alone, so a future field that carries any of them fails too rather than only the exact string.
    expect(rendered).not.toContain('SECRET-');
  });

  it('drops an absolute or escaping path rather than rewriting it, and counts what it dropped', () => {
    const pack = buildPortableRunEvidence(runWithEverything(), '2026-08-19T11:00:00.000Z');
    const delegation = pack.delegations[0];

    expect(delegation.changedFiles).toEqual(['src/billing.ts']);
    // Rewriting would invent a path that was never recorded; the count is what a reader can act on.
    expect(delegation.droppedAbsolutePaths).toBe(3);
    // The true total survives, so a reader can see the artifact is showing fewer paths than the run had.
    expect(delegation.changedFileCount).toBe(4);
  });

  it('exports the latest human verdict, unresolved-item count, and a document-local approver ordinal without its prose', () => {
    const run = runWithEverything();
    run.verdicts = [{
      verdict: 'accepted-with-exceptions', approverId: APPROVER_ID,
      recordedAt: '2026-08-19T10:35:00.000Z', evidenceReviewedAt: '2026-08-19T10:34:00.000Z',
      unresolvedItems: [UNRESOLVED_ITEM, 'A second internal item.'],
    }];

    const rendered = renderPortableRunEvidence(run);
    const pack = buildPortableRunEvidence(run);
    expect(pack.verdict).toEqual({
      value: 'accepted-with-exceptions', approver: 'approver-1',
      recordedAt: '2026-08-19T10:35:00.000Z', unresolvedItemCount: 2,
    });
    expect(rendered).not.toContain(UNRESOLVED_ITEM);
    expect(rendered).not.toContain(APPROVER_ID);
    expect(pack.omitted.excluded.map((entry) => entry.field)).toContain('verdict.unresolvedItems');
  });

  it('does not export a raw latest verdict whose approver is a system actor', () => {
    const run = runWithEverything();
    run.verdicts = [{
      verdict: 'accepted', approverId: 'system:host-disposed',
      recordedAt: '2026-08-19T10:35:00.000Z', evidenceReviewedAt: '2026-08-19T10:34:00.000Z',
      unresolvedItems: [],
    }];

    const pack = buildPortableRunEvidence(run);
    expect(pack).not.toHaveProperty('verdict');
    expect(pack.omitted.unavailable).toContainEqual(expect.objectContaining({
      field: 'verdict',
      reason: expect.stringMatching(/withheld.*human approver/i),
    }));
  });

  it('keeps the structured accounting the schema asks for', () => {
    const pack = buildPortableRunEvidence(runWithEverything(), '2026-08-19T11:00:00.000Z');

    expect(pack.version).toBe('portable-run-evidence/3');
    expect(pack.accounting).toEqual({
      dispatched: 1, settled: 1, cancelled: 0, refusedBeforeDispatch: 1, noExecutor: 0, dispositionsByKind: { accepted: 1 },
    });
    expect(pack.permissions).toEqual([
      {
        kind: 'command-approval', agent: 'agent-2', decision: 'allowed',
        recordedAt: '2026-08-19T10:05:00.000Z', approver: 'approver-1',
      },
    ]);
    // Whether verification ran and passed is a bounded fact; the command line is not, so it is excluded
    // rather than redacted — a redactor would have to recognise the token inside it to remove it.
    expect(pack.delegations[0].verification).toEqual({ ran: true, passed: true });
    expect(pack.delegations[0].verificationPlan).toEqual({
      sensors: ['recorded-file-effect', 'run-checks'], status: 'satisfied',
    });
    expect(pack.delegations[0]).not.toHaveProperty('requestedAgent');
    expect(pack.omitted.excluded.map((entry) => entry.field))
      .toEqual(expect.arrayContaining(['delegation.requestedAgent', 'verification.command', 'verificationPlan.prose']));
    expect(pack.delegations[0].usage).toMatchObject({ modelRequests: 4, toolCalls: 17, inputTokensEstimated: true });
    expect(pack.delegations[0].dispositions).toEqual(['accepted']);
  });

  it('exports the closed expiry and repair facts without their internal outcome correlation', () => {
    const run = runWithEverything();
    run.permissions.push({
      kind: 'tool-approval', agentId: DELEGATE_ID, decision: 'expired', recordedAt: '2026-08-19T10:07:00.000Z',
    });
    run.outcomeRepairs = [{
      outcomeId: 'SECRET-OUTCOME-ID-appr-47', category: 'consent-timeout', state: 'unavailable',
      recordedAt: '2026-08-19T10:07:00.000Z',
    }, {
      outcomeId: 'SECRET-OUTCOME-ID-forged', category: 'anything-else', state: 'invented',
      recordedAt: '2026-08-19T10:07:00.000Z',
    } as any];

    const pack = buildPortableRunEvidence(run);
    const rendered = renderPortableRunEvidence(run);
    expect(pack.permissions.at(-1)).toMatchObject({ kind: 'tool-approval', decision: 'expired' });
    expect(pack.outcomeRepairs).toEqual([{ category: 'consent-timeout', state: 'unavailable' }]);
    expect(rendered).not.toContain('SECRET-OUTCOME-ID-appr-47');
    expect(rendered).not.toContain('SECRET-OUTCOME-ID-forged');
    expect(pack.outcomeRepairs[0]).not.toHaveProperty('outcomeId');
  });

  describe('identifiers', () => {
    // A team file constrains an agent id to being a non-empty string. It is a name a person chose, and it can
    // name a client or a deal. The document only needs it to correlate rows, so an ordinal loses nothing.
    it('replaces every configured id with an ordinal, on one scale, stable within the document', () => {
      const pack = buildPortableRunEvidence(runWithEverything(), '2026-08-19T11:00:00.000Z');

      expect(pack.coordinator).toBe('agent-1');
      expect(pack.delegations[0].agent).toBe('agent-2');
      // The same agent appearing as a delegate and in a permission event keeps one ordinal.
      expect(pack.permissions[0].agent).toBe('agent-2');
      expect(pack.delegations[0]).not.toHaveProperty('agentId');
      expect(pack).not.toHaveProperty('coordinatorId');
    });

    it('replaces a stable approver identity with its own document-local ordinal', () => {
      const rendered = renderPortableRunEvidence(runWithEverything());
      const pack = JSON.parse(rendered) as ReturnType<typeof buildPortableRunEvidence>;

      expect(pack.permissions[0].approver).toBe('approver-1');
      expect(rendered).not.toContain(APPROVER_ID);
      expect(pack.omitted.excluded.map((entry) => entry.field)).toContain('permission.approverId');
    });

    it('does not invent an approver for an exercised MCP grant', () => {
      const run = runWithEverything();
      run.permissions.push({
        kind: 'mcp-grant', agentId: DELEGATE_ID, decision: 'allowed', recordedAt: '2026-08-19T10:06:00.000Z',
      });
      const pack = buildPortableRunEvidence(run);

      expect(pack.permissions[1]).not.toHaveProperty('approver');
      expect(pack.omitted.unavailable.map((entry) => entry.field)).toContain('permission.approver');
    });

    it('drops a forged approver from an MCP grant at the builder boundary', () => {
      const run = runWithEverything();
      run.permissions = [{
        kind: 'mcp-grant', agentId: DELEGATE_ID, decision: 'allowed', approverId: APPROVER_ID,
        recordedAt: '2026-08-21T18:00:00.000Z',
      }];
      const rendered = renderPortableRunEvidence(run);
      expect(rendered).not.toContain(APPROVER_ID);
      expect(buildPortableRunEvidence(run).permissions[0]).not.toHaveProperty('approver');
    });

    it('does not turn a system fail-closed actor into a human approver', () => {
      const run = runWithEverything();
      run.permissions[0].approverId = 'system:host-disposed';
      const pack = buildPortableRunEvidence(run);
      expect(pack.permissions[0]).not.toHaveProperty('approver');
      expect(pack.omitted.unavailable.map((entry) => entry.field)).toContain('permission.approver');
    });

    it('carries a role only when it is one of the shipped names', () => {
      const run = runWithEverything();
      const bounded = buildPortableRunEvidence(run, { roles: { [DELEGATE_ID]: 'reviewer' } });
      expect(bounded.delegations[0].role).toBe('reviewer');

      // Anything else is dropped rather than carried, so the guarantee does not rest on the caller.
      const unbounded = buildPortableRunEvidence(run, {
        roles: { [DELEGATE_ID]: 'SECRET-ROLE-lead counsel, Project X' },
      });
      expect(unbounded.delegations[0]).not.toHaveProperty('role');
      expect(JSON.stringify(unbounded)).not.toContain('SECRET-');
    });
  });

  describe('route and write-time digest boundaries', () => {
    it('keeps the named connection class while withholding a private hostname and privacy id', () => {
      const pack = buildPortableRunEvidence(runWithEverything());
      const rendered = JSON.stringify(pack);

      expect(pack.delegations[0]).toMatchObject({
        routeId: 'custom-gateway',
        executionDomain: 'custom-gateway',
        privacyDomain: 'unresolved-user-selected',
      });
      expect(rendered).not.toContain('SECRET-private-gateway');
      expect(rendered).not.toContain('custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    });

    it('does not trust a built-in route name that points at a different endpoint', () => {
      const run = runWithEverything();
      run.delegations[0].route = {
        routeId: 'openai',
        connectionKind: 'openai-compatible',
        executionDomain: PRIVATE_GATEWAY,
        privacyDomain: { id: `unresolved-user-selected:${PRIVATE_GATEWAY}|model`, status: 'unresolved-user-selected' },
      };

      const pack = buildPortableRunEvidence(run);
      expect(pack.delegations[0]).not.toHaveProperty('routeId');
      expect(pack.delegations[0]).not.toHaveProperty('executionDomain');
      expect(JSON.stringify(pack)).not.toContain(PRIVATE_GATEWAY);
      expect(pack.omitted.unavailable.map((entry) => entry.field)).toContain('delegation.routeId');
    });

    it('carries only path and SHA-256 values for a complete changed-file set', () => {
      const before = 'SECRET-SOURCE-BEFORE';
      const after = 'SECRET-SOURCE-AFTER';
      const run = runWithEverything();
      run.delegations[0].evidence!.changedFiles = ['src/billing.ts'];
      run.delegations[0].diffDigest = oneFileDigest('src/billing.ts', before, after);

      const rendered = renderPortableRunEvidence(run);
      const digest = buildPortableRunEvidence(run).delegations[0].diffDigest;
      expect(digest).toEqual(run.delegations[0].diffDigest);
      expect(rendered).not.toContain(before);
      expect(rendered).not.toContain(after);
      expect(buildPortableRunEvidence(run).omitted.unavailable.map((entry) => entry.field))
        .not.toContain('delegation.diffDigest');
    });

    it('keeps a complete create-then-delete receipt even though both final sides are absent', () => {
      const run = runWithEverything();
      run.delegations[0].evidence!.changedFiles = ['src/transient.ts'];
      run.delegations[0].diffDigest = oneFileDigest('src/transient.ts', null, null);

      expect(buildPortableRunEvidence(run).delegations[0].diffDigest?.files).toEqual([{
        path: 'src/transient.ts', beforeContentHash: null, afterContentHash: null,
      }]);
    });

    it('refuses a caller-supplied digest that does not match its paths and hashes', () => {
      const run = runWithEverything();
      run.delegations[0].evidence!.changedFiles = ['src/billing.ts'];
      run.delegations[0].diffDigest = {
        ...oneFileDigest('src/billing.ts', 'before', 'after'),
        value: 'f'.repeat(64),
      };

      const pack = buildPortableRunEvidence(run);
      expect(pack.delegations[0]).not.toHaveProperty('diffDigest');
      expect(pack.omitted.unavailable.map((entry) => entry.field)).toContain('delegation.diffDigest');
    });
  });

  /**
   * What the format keeps is declared too. "No prose" is a strong enough claim to stop a sender checking the
   * file before they attach it, so the file has to tell them what is in it — not only what is not.
   */
  describe('what it deliberately keeps', () => {
    it('keeps workspace-relative changed paths, and says so inside the artifact', () => {
      const pack = buildPortableRunEvidence(runWithEverything(), '2026-08-19T11:00:00.000Z');

      expect(pack.delegations[0].changedFiles).toEqual(['src/billing.ts']);
      expect(pack.retained.map((entry) => entry.field)).toContain('delegation.changedFiles');
      for (const entry of pack.retained) {
        expect(entry.reason.length, `${entry.field} needs a reason a sender can act on`).toBeGreaterThan(20);
      }
    });

    // Stated as a test so it is a decision rather than an oversight: a path inside the workspace survives.
    it('does not treat a workspace-relative path as something to strip', () => {
      const run = runWithEverything();
      run.delegations[0].evidence!.changedFiles = ['clients/acme/plan.md'];

      expect(renderPortableRunEvidence(run)).toContain('clients/acme/plan.md');
    });
  });

  // A reader cannot audit an absence they cannot see, so the declaration is part of the schema.
  it('declares what it withheld separately from what was never recorded', () => {
    const pack = buildPortableRunEvidence(runWithEverything());

    expect(pack.omitted.excluded).toBe(PORTABLE_EXCLUSIONS);
    expect(pack.omitted.unavailable).not.toBe(PORTABLE_UNAVAILABLE);
    expect(pack.omitted.excluded.map((entry) => entry.field)).toContain('run.objective');
    expect(pack.omitted.excluded.map((entry) => entry.field)).toContain('delegation.instruction');
    // Presenting "never recorded" as "deliberately withheld" would imply a privacy decision that was not made.
    expect(pack.omitted.unavailable.map((entry) => entry.field)).toContain('delegation.diffDigest');
    expect(pack.retained.map((entry) => entry.field)).not.toContain('delegation.diffDigest');
    for (const entry of [...pack.omitted.excluded, ...pack.omitted.unavailable]) {
      expect(entry.reason.length, `${entry.field} needs a reason a reader can act on`).toBeGreaterThan(20);
    }
  });
});

describe('workspace-relative path test', () => {
  it('derives the portable root schema from exhaustive field policy without changing its public shape', () => {
    expect(PORTABLE_SCHEMA_FIELDS.$).toEqual([
      'version', 'runId', 'coordinator', 'status', 'startedAt', 'endedAt', 'closeoutCompletionState', 'exportedAt',
      'accounting', 'permissions', 'outcomeRepairs', 'verdict', 'delegations', 'content', 'omitted', 'retained',
    ]);
    for (const [field, policy] of Object.entries(RUN_RECORD_FIELDS)) {
      if (policy.portable === false) {
        expect(policy.reason, `${field} needs a portability reason`).toEqual(expect.any(String));
        expect(policy.reason.length, `${field} needs a non-empty portability reason`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the v3 input-receipt public key in the runtime schema allow-list', () => {
    expect(PORTABLE_SCHEMA_FIELDS.inputReceipt).toEqual(['input', 'supplied', 'reachable', 'readReceipt']);
    expect(PORTABLE_SCHEMA_FIELDS.inputReceipt).not.toContain('read');
  });

  it('accepts only what it can prove is inside the workspace', () => {
    for (const ok of ['src/a.ts', 'a.ts', 'src/nested/deep/file.tsx', 'docs/RELEASE.md']) {
      expect(isPortableRelativePath(ok), ok).toBe(true);
    }
    for (const bad of [
      '/etc/passwd', '\\\\server\\share\\x', 'C:\\Users\\me\\x.ts', 'c:/Users/me/x.ts',
      '~/secrets.txt', '../outside.ts', 'src/../../outside.ts', '', ' src/a.ts',
      // Absolute, but not by starting with a separator — the shapes the first filter let through.
      'file:///C:/Users/me/private.txt', 'file:///etc/passwd', 'C:private.txt', 'c:notes.md',
      'src/notes.txt:hidden-stream', 'https://internal.example/x',
      // Not expanded yet, but they name somewhere outside the workspace all the same.
      '$HOME/.ssh/id_rsa', '%USERPROFILE%\\Desktop\\x.txt', '~',
      // Not plainly stated from the workspace root.
      './a.ts', 'src//a.ts', 'src/', 'a/./b.ts',
    ]) {
      expect(isPortableRelativePath(bad), bad).toBe(false);
    }
  });
});
