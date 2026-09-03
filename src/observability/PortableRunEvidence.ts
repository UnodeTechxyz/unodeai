import { createHash } from 'crypto';
import {
  describeRunVerdictWithholding,
  isContemporaneousApprover,
  latestRunVerdictResolution,
  RUN_RECORD_FIELDS,
  type RunDiffDigest,
  type RunRecord,
  type RunRouteReceipt,
  type RunVerdict,
} from './RunLedger';
import { sanitizeContentReceipt } from '../content/ContentReceipt';
import type { DelegationCompletionState, RunCloseoutCompletionState } from '../types';

/**
 * Portable Run Evidence v3 — the artifact a team can hand to a client or an auditor.
 *
 * This is **not** a variant of `RunEvidencePack`. That pack retains the user's objective and every task
 * instruction, redacted only by credential pattern-matching, and says so; it is an internal record for the
 * person who ran the work. This one is built for an outside reader, so the rule is inverted:
 *
 *   **No prose. Nothing a user or a model composed as text — no request, instruction, reason, label,
 *   command line or file content — and nothing that is not either a bounded value or a declared exception.**
 *
 * That rule is what makes the exclusions testable rather than aspirational. A redactor has to recognise a
 * secret to remove it; a format that carries no composed text has nothing to recognise. The hard exclusions
 * this format must honour are: raw prompt, task title, source bytes, absolute paths, environment values,
 * credentials, tool payloads, and full command output.
 *
 * **The earlier version of this comment said "only bounded, structured values", and the artifact did not
 * honour it.** An agent id is a user-chosen string that a team file constrains only to being non-empty, so
 * `agentId: "Project-X-acquisition"` reached the export intact; and workspace-relative paths are file names
 * a person wrote. Two different answers were needed, not one:
 *
 * - **Identifiers are replaced by ordinals.** `agent-1`, `agent-2`, assigned in dispatch order. The document
 *   only ever needs them to correlate rows with each other, so nothing of evidentiary value is lost and the
 *   worst leak closes completely. A bounded role name is carried alongside when the caller can supply one —
 *   validated here against a closed set, so the guarantee does not depend on the caller behaving.
 * - **Changed file paths are kept, and declared.** They are the evidence; reducing them to counts and
 *   extensions would leave an artifact a reviewer cannot review. So the format states plainly, inside itself,
 *   that it carries them.
 *
 * Both directions are declared in the artifact: `omitted` for what is absent and `retained` for the
 * identifying content that is present. A reader cannot audit an absence they cannot see, and a sender cannot
 * audit a presence nobody told them about. Both declarations are schema requirements, not courtesies.
 */

/** v3 adds structured closeout/completion state and sensor-bounded read receipts. */
export const PORTABLE_RUN_EVIDENCE_VERSION = 'portable-run-evidence/3' as const;

/** One excluded field, with the reason a reader needs to judge what the artifact cannot show them. */
export interface PortableOmission {
  field: string;
  reason: string;
}

/**
 * Declared in the artifact so an outside reader can see the shape of what is missing.
 *
 * Two categories, and the difference matters to a reader: `excluded` was deliberately withheld, `unavailable`
 * was never recorded. Presenting the second as the first would imply a privacy decision where there was only
 * a gap, and presenting the first as the second would hide a choice.
 */
export const PORTABLE_EXCLUSIONS: readonly PortableOmission[] = Object.freeze([
  { field: 'run.objective', reason: 'The user request is free text; a portable artifact carries no prose.' },
  { field: 'delegation.instruction', reason: 'A task instruction is free text and may restate the request.' },
  { field: 'refusal.reason', reason: 'Host-generated, but interpolates the requested agent reference.' },
  { field: 'permission.label', reason: 'Carries the command or URL a decision was made about, not a category.' },
  { field: 'disposition.reason', reason: 'A coordinator decision reason is free text.' },
  { field: 'verdict.unresolvedItems', reason: 'A human’s unresolved-item prose is retained only in the internal ledger; portable evidence carries its count.' },
  { field: 'delegation.requestedAgent', reason: 'The agent reference a model typed into a tool call is free text, not a host identifier.' },
  { field: 'agent.id', reason: 'A configured agent id is a name a person chose; the export replaces it with an ordinal.' },
  { field: 'outcomeRepair.id', reason: 'The opaque host correlation stays internal; the portable record carries only its closed category and lifecycle state.' },
  { field: 'agent.name', reason: 'A display name is free text and is never carried, under any key.' },
  { field: 'permission.approverId', reason: 'A stable local or remote actor id is replaced by a document-local approver ordinal.' },
  { field: 'delegation.route.routeId', reason: 'A machine-local route id is replaced by a builder-validated built-in name or custom-gateway category.' },
  { field: 'delegation.route.executionDomain', reason: 'The exact endpoint may name a private gateway; the export carries only a bounded execution-domain category.' },
  { field: 'delegation.route.privacyDomain.id', reason: 'The privacy-domain id can embed an endpoint and model; the export carries only its bounded resolution status.' },
  { field: 'verification.command', reason: 'A command line can carry an absolute path, an inline token or an environment value.' },
  { field: 'verificationPlan.prose', reason: 'A verification plan is exported as closed sensor kinds only; task prose never enters portable evidence.' },
  { field: 'context.entries', reason: 'Source labels and locations can be absolute paths or private names.' },
  { field: 'activity', reason: 'Tool payloads and command output.' },
  { field: 'file.contents', reason: 'Source bytes are never in an evidence artifact.' },
  { field: 'content.assetId', reason: 'A temporary host asset id is replaced by a document-local opaque ordinal.' },
  { field: 'content.source', reason: 'Source URL, attachment name, temporary path, bytes, query and extracted text never enter portable evidence.' },
  { field: 'contract.objective', reason: 'A coordinator-authored objective is prose; portable evidence carries no contract prose.' },
  { field: 'contract.expectedDeliverable', reason: 'A coordinator-authored deliverable is prose; portable evidence carries no contract prose.' },
  { field: 'contract.input.purpose', reason: 'Input purpose is shown internally to the coordinator but is prose and never exported.' },
  { field: 'contract.constraint.text', reason: 'Constraints are coordinator claims expressed as prose and never exported.' },
  { field: 'contract.coordinatorBrief', reason: 'A coordinator brief is a coordinator claim expressed as prose and never exported.' },
  { field: 'contract.sourceIdentifiers', reason: 'Content ids, workspace paths and artifact handles are omitted; context-gap inputs use document-local ordinals.' },
  { field: 'taskAttempt.id', reason: 'Attempt and contract ids are internal authorisation identities and are never exported.' },
  { field: 'artifact.identifiersAndProvenance', reason: 'Artifact handles, content ids, producer identities and provenance input ids stay in the internal ledger.' },
]);

/**
 * Identifying content this format deliberately keeps.
 *
 * Declared for the sender, not the reader: the person about to attach this file to an email is the one who
 * needs to know what is in it, and "no prose" is a claim strong enough to stop them checking.
 */
export const PORTABLE_RETAINED: readonly PortableOmission[] = Object.freeze([
  {
    field: 'delegation.changedFiles',
    reason: 'Workspace-relative paths are the evidence a reviewer reads; a count and an extension is not reviewable. Absolute and escaping paths are still dropped and counted.',
  },
  {
    field: 'timestamps',
    reason: 'Dispatch, settlement and export times, which disclose when the work was done.',
  },
  {
    field: 'delegation.diffDigest',
    reason: 'SHA-256 digests and per-file content hashes are retained to prove change equality; they disclose equality and permit confirmation guesses, but never retain source bytes.',
  },
  {
    field: 'content.receipts',
    reason: 'Bounded rich-content facts only: class, extraction outcome, page coverage, truncation, OCR state and a document-local ordinal. No source or content is retained.',
  },
]);

export const PORTABLE_UNAVAILABLE: readonly PortableOmission[] = Object.freeze([
  {
    field: 'permission.approver',
    reason: 'Absent when no contemporaneous actor was recorded. Exercised MCP grants have no decision; expired prompts and historical rows also cannot name an approver. The export never guesses an actor.',
  },
  {
    field: 'content.receipts',
    reason: 'No bounded rich-content receipt was recorded for this run.',
  },
  {
    field: 'verdict',
    reason: 'A stored verdict was withheld because it did not satisfy the contemporaneous human-verdict boundary.',
  },
]);

export interface PortableDelegation {
  handle: string;
  /** `agent-N`, assigned in dispatch order. Never the configured id, which is a name a person chose. */
  agent: string;
  /** Present only when the configured role is one of a closed, shipped set. */
  role?: string;
  dispatchedAt: string;
  state: 'active' | 'settled' | 'cancelled';
  completionState?: DelegationCompletionState;
  cancelledAt?: string;
  /** A closed connection name/category. Exact custom ids and endpoint hostnames never leave. */
  routeId?: PortableRouteId;
  executionDomain?: PortableExecutionDomain;
  privacyDomain?: PortablePrivacyDomain;
  /** Categories only — never the underlying values. */
  outcome?: string;
  changedFileCount?: number;
  /** Relative to the workspace. An entry that could not be proved relative is dropped, not rewritten. */
  changedFiles?: string[];
  droppedAbsolutePaths?: number;
  diffDigest?: PortableDiffDigest;
  /** Whether verification ran and whether it passed. The command itself is excluded, not redacted. */
  verification?: { ran: boolean; passed: boolean };
  /** Sensor kinds and host result only: a portable plan never carries a command line or prose. */
  verificationPlan?: {
    sensors: Array<'command-exit-zero' | 'editor-diagnostics-clean' | 'recorded-file-effect' | 'run-checks'>;
    status?: 'no-applicable-sensor' | 'satisfied' | 'not-run' | 'failed';
  };
  unrecordedWrites?: boolean;
  temporaryScope?: { readGrants: number; readwriteGrants: number };
  dispositions: string[];
  /** Independent task state. The source identifier is a document-local ordinal and purpose is omitted. */
  taskStates?: Array<{
    kind: 'context-gap';
    input: string;
    reason: 'missing' | 'expired' | 'outside-task-scope' | 'unreadable';
  }>;
  /** Host-observed proof vocabulary only. Source references and timestamps stay internal. */
  inputReceipts?: Array<{
    input: string;
    supplied: true;
    reachable: boolean;
    readReceipt: 'observed' | 'not-observed';
  }>;
  usage?: {
    modelRequests: number;
    toolCalls: number;
    inputTokens?: number;
    /** True when the token count is reconstructed rather than reported by the provider. */
    inputTokensEstimated?: boolean;
    durationMs: number;
    longestNoMaterialProgressMs: number;
  };
}

export type PortableRouteId =
  | 'unode'
  | 'roam'
  | 'openrouter'
  | 'openai'
  | 'claude-cli'
  | 'codex-cli'
  | 'custom-gateway';

export type PortableExecutionDomain = 'built-in-service' | 'local-cli-service' | 'custom-gateway';
export type PortablePrivacyDomain = 'known' | 'unknown' | 'unresolved-user-selected';

export interface PortableDiffDigest {
  algorithm: 'sha256';
  value: string;
  files: Array<{
    path: string;
    beforeContentHash: string | null;
    afterContentHash: string | null;
  }>;
}

/** A content consultation with source and payload deliberately removed. */
export interface PortableContentReceipt {
  /** `content-N`, assigned by this export rather than copied from host storage. */
  ordinal: string;
  contentClass: 'pdf' | 'image' | 'conversation';
  action: 'stored' | 'read' | 'searched' | 'sent' | 'refused' | 'omitted';
  /** PDF-only extraction state. Images deliberately have no locally-derived prose in v0.9.58. */
  extractionAttempted?: boolean;
  extractionSucceeded?: boolean;
  pages?: { start: number; end: number; total: number; extracted?: number };
  truncated?: boolean;
  ocrRequired?: boolean;
  /** Image-routing-only state; never includes provider name, endpoint or media bytes. */
  processingClass?: 'local-storage' | 'remote-vision';
  consentOutcome?: 'approved' | 'declined' | 'not-requested';
  /** Own-conversation-only range; transcript text and search terms never leave the host. */
  entries?: { start: number; end: number; total: number; returned?: number };
}

export interface PortableRunEvidence {
  version: typeof PORTABLE_RUN_EVIDENCE_VERSION;
  runId: string;
  /** The coordinator's ordinal, on the same scale as every other agent in the document. */
  coordinator: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  closeoutCompletionState?: RunCloseoutCompletionState;
  exportedAt: string;
  accounting: {
    dispatched: number;
    settled: number;
    cancelled: number;
    refusedBeforeDispatch: number;
    noExecutor: number;
    dispositionsByKind: Record<string, number>;
  };
  permissions: Array<{
    kind: string;
    agent: string;
    decision: 'allowed' | 'denied' | 'expired';
    recordedAt: string;
    /** Present only for a contemporaneous human decision; always a document-local ordinal. */
    approver?: string;
  }>;
  /** Content-free repair facts. No outcome id, agent, target, task, attempt, grant, or approver leaves the host. */
  outcomeRepairs: Array<{
    category: 'consent-timeout' | 'delegate-empty';
    state: 'offered' | 'invoked' | 'unavailable';
  }>;
  /** Present only for a recorded human decision; unjudged is represented by this field being absent. */
  verdict?: {
    value: RunVerdict;
    approver: string;
    recordedAt: string;
    unresolvedItemCount: number;
  };
  delegations: PortableDelegation[];
  /** Omitted for runs with no content consultation; its absence is declared in `omitted.unavailable`. */
  content?: PortableContentReceipt[];
  omitted: { excluded: readonly PortableOmission[]; unavailable: readonly PortableOmission[] };
  retained: readonly PortableOmission[];
}

const PORTABLE_ENVELOPE_ROOT_FIELDS = Object.freeze([
  { key: 'version', order: 0 },
  { key: 'exportedAt', order: 7 },
  { key: 'omitted', order: 14 },
  { key: 'retained', order: 15 },
] as const);

function portableRootFields(): readonly string[] {
  const fields = [
    ...PORTABLE_ENVELOPE_ROOT_FIELDS,
    ...Object.entries(RUN_RECORD_FIELDS).flatMap(([field, policy]) => {
      if (policy.portable === false) return [];
      return [{ key: policy.portable === true ? field : policy.portable, order: policy.portableOrder }];
    }),
  ].sort((left, right) => left.order - right.order || left.key.localeCompare(right.key));
  return [...new Set(fields.map((field) => field.key))];
}

/** Runtime-auditable key allow-list. Tests walk a production-ledger export against this exact schema. */
export const PORTABLE_SCHEMA_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '$': Object.freeze(portableRootFields()),
  accounting: Object.freeze([
    'dispatched', 'settled', 'cancelled', 'refusedBeforeDispatch', 'noExecutor', 'dispositionsByKind',
  ]),
  permission: Object.freeze(['kind', 'agent', 'decision', 'recordedAt', 'approver']),
  outcomeRepair: Object.freeze(['category', 'state']),
  verdict: Object.freeze(['value', 'approver', 'recordedAt', 'unresolvedItemCount']),
  delegation: Object.freeze([
    'handle', 'agent', 'role', 'dispatchedAt', 'state', 'completionState', 'cancelledAt', 'routeId', 'executionDomain',
    'privacyDomain', 'outcome', 'changedFileCount', 'changedFiles', 'droppedAbsolutePaths', 'diffDigest',
    'verification', 'verificationPlan', 'unrecordedWrites',
    'temporaryScope', 'dispositions', 'usage',
    'taskStates', 'inputReceipts',
  ]),
  taskState: Object.freeze(['kind', 'input', 'reason']),
  inputReceipt: Object.freeze(['input', 'supplied', 'reachable', 'readReceipt']),
  diffDigest: Object.freeze(['algorithm', 'value', 'files']),
  diffFile: Object.freeze(['path', 'beforeContentHash', 'afterContentHash']),
  verification: Object.freeze(['ran', 'passed']),
  verificationPlan: Object.freeze(['sensors', 'status']),
  temporaryScope: Object.freeze(['readGrants', 'readwriteGrants']),
  usage: Object.freeze([
    'modelRequests', 'toolCalls', 'inputTokens', 'inputTokensEstimated', 'durationMs',
    'longestNoMaterialProgressMs',
  ]),
  contentReceipt: Object.freeze([
    'ordinal', 'contentClass', 'action', 'extractionAttempted', 'extractionSucceeded', 'pages', 'truncated', 'ocrRequired',
    'processingClass', 'consentOutcome', 'entries',
  ]),
  contentPages: Object.freeze(['start', 'end', 'total', 'extracted']),
  contentEntries: Object.freeze(['start', 'end', 'total', 'returned']),
  omitted: Object.freeze(['excluded', 'unavailable']),
  declaration: Object.freeze(['field', 'reason']),
});

/**
 * A path is kept only when it can be *proved* workspace-relative.
 *
 * Rewriting an absolute path into a relative one would require knowing the workspace root at export time and
 * would silently produce a path that was never recorded. Dropping and counting is the honest operation: the
 * artifact then says how many paths it could not carry, which a reader can act on.
 *
 * This is an allow-list on purpose. The first version listed the shapes to forbid and let everything else
 * through, which is the wrong default for a filter whose failure mode is disclosure: `file:///C:/Users/...`,
 * `file:///etc/passwd` and `C:private.txt` all passed it. Anything that is not plainly a sequence of ordinary
 * relative segments is dropped now, even at the cost of dropping the occasional legitimate path — the count
 * says so, and an over-dropped path is a gap while an under-dropped one is a leak.
 */
export function isPortableRelativePath(path: string): boolean {
  if (!path || path.trim() !== path) { return false; }
  // A colon is a drive letter (`C:private.txt`), a URI scheme (`file:///etc/passwd`) or an NTFS alternate
  // data stream. None of them is a relative path, and a colon is not legal in a Windows file name anyway.
  if (path.includes(':')) { return false; }
  if (path.includes('\0')) { return false; }
  if (path.startsWith('/') || path.startsWith('\\')) { return false; }
  // `~/x`, `$HOME/x` and `%USERPROFILE%\\x` are absolute paths that have not been expanded yet.
  if (path.startsWith('~') || /[$%]/.test(path)) { return false; }
  // Empty rejects `//server/share` and `a//b`; `.`/`..` reject a path not stated plainly from the root.
  return path.split(/[\\/]/).every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Roles a delegation may be labelled with.
 *
 * Deliberately a copy of the team-file role vocabulary rather than an import of it: this list exists to
 * bound what may leave the organisation, and it must not silently widen because a runtime role set grew. A
 * role that is not on it is simply not carried.
 */
export const PORTABLE_ROLE_VOCABULARY: ReadonlySet<string> = new Set([
  'architect', 'developer', 'reviewer', 'qa', 'pm', 'product-manager', 'devops', 'tech-writer',
  'security', 'data-engineer', 'senior-dev', 'tester', 'solo', 'custom',
]);

const BUILTIN_ROUTE_DOMAINS: Readonly<Record<Exclude<PortableRouteId, 'custom-gateway'>, {
  kind: RunRouteReceipt['connectionKind'];
  endpoint: string;
  executionDomain: PortableExecutionDomain;
}>> = Object.freeze({
  unode: { kind: 'openai-compatible', endpoint: 'https://www.unodetech.xyz/v1', executionDomain: 'built-in-service' },
  roam: { kind: 'openai-compatible', endpoint: 'https://ai.weroam.xyz/v1', executionDomain: 'built-in-service' },
  openrouter: { kind: 'openai-compatible', endpoint: 'https://openrouter.ai/api/v1', executionDomain: 'built-in-service' },
  openai: { kind: 'openai-compatible', endpoint: 'https://api.openai.com/v1', executionDomain: 'built-in-service' },
  'claude-cli': { kind: 'claude-headless', endpoint: 'https://api.anthropic.com/', executionDomain: 'local-cli-service' },
  'codex-cli': { kind: 'codex-headless', endpoint: 'https://api.openai.com/', executionDomain: 'local-cli-service' },
});

function boundedRoute(route: RunRouteReceipt | undefined): {
  routeId: PortableRouteId;
  executionDomain: PortableExecutionDomain;
  privacyDomain: PortablePrivacyDomain;
} | undefined {
  if (!route || !['known', 'unknown', 'unresolved-user-selected'].includes(route.privacyDomain?.status)) {
    return undefined;
  }
  const builtin = BUILTIN_ROUTE_DOMAINS[route.routeId as Exclude<PortableRouteId, 'custom-gateway'>];
  if (builtin) {
    return builtin.kind === route.connectionKind && builtin.endpoint === route.executionDomain
      ? {
        routeId: route.routeId as Exclude<PortableRouteId, 'custom-gateway'>,
        executionDomain: builtin.executionDomain,
        privacyDomain: route.privacyDomain.status,
      }
      : undefined;
  }
  if (!/^custom:[a-f0-9]{32}$/.test(route.routeId) || route.connectionKind !== 'openai-compatible' ||
      !isCustomEndpointShape(route.executionDomain)) {
    return undefined;
  }
  return {
    routeId: 'custom-gateway',
    executionDomain: 'custom-gateway',
    privacyDomain: route.privacyDomain.status,
  };
}

function isCustomEndpointShape(value: string): boolean {
  try {
    const endpoint = new URL(value);
    return endpoint.protocol === 'https:' && !!endpoint.hostname && !endpoint.username && !endpoint.password &&
      !endpoint.search && !endpoint.hash;
  } catch {
    return false;
  }
}

function boundedDiffDigest(
  digest: RunDiffDigest | undefined,
  changedFiles: readonly string[] | undefined,
): PortableDiffDigest | undefined {
  if (!digest || digest.algorithm !== 'sha256' || !isSha256(digest.value) || !Array.isArray(changedFiles)) {
    return undefined;
  }
  const expected = [...new Set(changedFiles)].sort(compareStrings);
  if (expected.some((path) => !isPortableRelativePath(path)) || digest.files.length !== expected.length) {
    return undefined;
  }
  const seen = new Set<string>();
  const files: PortableDiffDigest['files'] = [];
  for (const file of digest.files) {
    if (!file || !isPortableRelativePath(file.path) || seen.has(file.path) ||
        (file.beforeContentHash !== null && !isSha256(file.beforeContentHash)) ||
        (file.afterContentHash !== null && !isSha256(file.afterContentHash))) {
      return undefined;
    }
    seen.add(file.path);
    files.push({
      path: file.path,
      beforeContentHash: file.beforeContentHash,
      afterContentHash: file.afterContentHash,
    });
  }
  files.sort((left, right) => compareStrings(left.path, right.path));
  if (files.some((file, index) => file.path !== expected[index])) {
    return undefined;
  }
  const value = digestValue(files);
  return value === digest.value ? { algorithm: 'sha256', value, files } : undefined;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function digestValue(files: ReadonlyArray<PortableDiffDigest['files'][number]>): string {
  const canonical = files.map((file) => JSON.stringify([
    file.path,
    file.beforeContentHash,
    file.afterContentHash,
  ])).join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface PortableRunEvidenceOptions {
  exportedAt?: string;
  /**
   * Configured role per agent id, if the caller can resolve it from the roster. Validated against
   * `PORTABLE_ROLE_VOCABULARY` here, so passing something else drops the label rather than leaking it.
   */
  roles?: Readonly<Record<string, string>>;
}

export function buildPortableRunEvidence(
  run: RunRecord,
  optionsOrExportedAt: PortableRunEvidenceOptions | string = {},
): PortableRunEvidence {
  const options = typeof optionsOrExportedAt === 'string' ? { exportedAt: optionsOrExportedAt } : optionsOrExportedAt;
  const exportedAt = options.exportedAt ?? new Date().toISOString();

  // One ordinal per configured id, stable for the life of this document. The coordinator is numbered on the
  // same scale as everyone else: a separate word for it would say which row is the coordinator twice.
  const ordinals = new Map<string, string>();
  const alias = (agentId: string): string => {
    const existing = ordinals.get(agentId);
    if (existing) { return existing; }
    const assigned = `agent-${ordinals.size + 1}`;
    ordinals.set(agentId, assigned);
    return assigned;
  };
  const boundedRole = (agentId: string): string | undefined => {
    const role = options.roles?.[agentId];
    return role && PORTABLE_ROLE_VOCABULARY.has(role) ? role : undefined;
  };
  const approverOrdinals = new Map<string, string>();
  const approverAlias = (approverId: string): string => {
    const existing = approverOrdinals.get(approverId);
    if (existing) { return existing; }
    const assigned = `approver-${approverOrdinals.size + 1}`;
    approverOrdinals.set(approverId, assigned);
    return assigned;
  };
  const coordinator = alias(run.coordinatorId);
  // The temporary store's id is intentionally not exported. This ordinal persists only within the
  // portable document so a reviewer can correlate a store/read/search sequence without learning a
  // source-specific identifier.
  const contentOrdinals = new Map<string, string>();
  const contentOrdinal = (assetId: string): string => {
    const existing = contentOrdinals.get(assetId);
    if (existing) { return existing; }
    const assigned = `content-${contentOrdinals.size + 1}`;
    contentOrdinals.set(assetId, assigned);
    return assigned;
  };
  const inputOrdinals = new Map<string, string>();
  const inputOrdinal = (identity: string): string => {
    const existing = inputOrdinals.get(identity);
    if (existing) return existing;
    const assigned = `input-${inputOrdinals.size + 1}`;
    inputOrdinals.set(identity, assigned);
    return assigned;
  };

  const dispositionsByKind: Record<string, number> = {};
  const unavailable: PortableOmission[] = [];
  const declareUnavailable = (field: string, reason: string): void => {
    if (!unavailable.some((entry) => entry.field === field)) {
      unavailable.push({ field, reason });
    }
  };
  const delegations: PortableDelegation[] = run.delegations.map((delegation) => {
    const evidence = delegation.evidence;
    const progress = delegation.progress;
    const route = boundedRoute(delegation.route);
    const diffDigest = boundedDiffDigest(delegation.diffDigest, evidence?.changedFiles);
    const kept: string[] = [];
    let dropped = 0;
    for (const file of evidence?.changedFiles ?? []) {
      if (isPortableRelativePath(file)) { kept.push(file); } else { dropped++; }
    }
    for (const disposition of delegation.dispositions) {
      dispositionsByKind[disposition.disposition] = (dispositionsByKind[disposition.disposition] ?? 0) + 1;
    }
    if (!route) {
      declareUnavailable('delegation.routeId', 'One or more delegations predate route receipts or failed strict route validation; the builder will not guess a connection class.');
      declareUnavailable('run.executionDomain', 'One or more delegation destinations were not recorded or did not match a builder-owned endpoint class.');
      declareUnavailable('run.privacyDomain', 'One or more delegation privacy-domain states were not recorded or failed the closed status vocabulary.');
    }
    if (!diffDigest) {
      declareUnavailable(
        'delegation.diffDigest',
        delegation.diffDigestUnavailable
          ? `At least one delegation cannot supply a complete file digest because ${delegation.diffDigestUnavailable}.`
          : 'At least one delegation predates write-time hashing or its path/hash set failed strict builder validation.',
      );
    }
    return {
      handle: delegation.handle,
      agent: alias(delegation.agentId),
      ...(boundedRole(delegation.agentId) ? { role: boundedRole(delegation.agentId)! } : {}),
      dispatchedAt: delegation.dispatchedAt,
      state: delegation.state,
      ...(evidence ? { completionState: evidence.completionState } : {}),
      ...(delegation.cancelledAt ? { cancelledAt: delegation.cancelledAt } : {}),
      ...(route ? route : {}),
      ...(evidence
        ? {
          outcome: evidence.outcome,
          changedFileCount: evidence.changedFiles.length,
          changedFiles: kept,
          ...(dropped > 0 ? { droppedAbsolutePaths: dropped } : {}),
          ...(diffDigest ? { diffDigest } : {}),
          ...(evidence.verification
            ? { verification: { ran: evidence.verification.ran, passed: evidence.verification.passed } }
            : {}),
          ...(delegation.verificationPlan
            ? {
              verificationPlan: {
                sensors: [...delegation.verificationPlan.sensors],
                ...(evidence.verificationPlanStatus ? { status: evidence.verificationPlanStatus } : {}),
              },
            }
            : {}),
          unrecordedWrites: evidence.unrecordedWrites,
        }
        : {}),
      ...(delegation.temporaryScope
        ? { temporaryScope: { readGrants: delegation.temporaryScope.readGrants, readwriteGrants: delegation.temporaryScope.readwriteGrants } }
        : {}),
      dispositions: delegation.dispositions.map((event) => event.disposition),
      ...(evidence?.contextGaps?.length
        ? {
          taskStates: evidence.contextGaps.map((gap) => ({
            kind: 'context-gap' as const,
            input: inputOrdinal(`${gap.attemptId}\u0000${gap.inputId}`),
            reason: gap.reason,
          })),
        }
        : {}),
      ...(evidence?.inputGrants?.length
        ? {
          inputReceipts: evidence.inputGrants.map((grant) => ({
            input: inputOrdinal(`${grant.attemptId}\u0000${grant.inputId}`),
            supplied: true as const,
            reachable: grant.reachableAt !== undefined,
            readReceipt: grant.readAt !== undefined ? 'observed' as const : 'not-observed' as const,
          })),
        }
        : {}),
      ...(progress
        ? {
          usage: {
            modelRequests: progress.modelRequests,
            toolCalls: progress.toolCalls,
            ...(progress.inputTokens !== undefined ? { inputTokens: progress.inputTokens } : {}),
            ...(progress.inputTokensEstimated !== undefined ? { inputTokensEstimated: progress.inputTokensEstimated } : {}),
            durationMs: progress.durationMs,
            longestNoMaterialProgressMs: progress.longestNoMaterialProgressMs,
          },
        }
        : {}),
    };
  });
  const content = run.contentReceipts.flatMap((receipt): PortableContentReceipt[] => {
    // A persisted row can predate this receipt type or be hand-edited. Re-validate at export rather than
    // assuming the ledger's write boundary was the only entry point.
    const safe = sanitizeContentReceipt(receipt);
    if (!safe) { return []; }
    return safe.contentClass === 'conversation'
      ? [{
        ordinal: 'own-conversation',
        contentClass: 'conversation',
        action: safe.action,
        entries: safe.entries,
      }]
      : safe.contentClass === 'image'
      ? [{
        ordinal: contentOrdinal(safe.assetId),
        contentClass: safe.contentClass,
        action: safe.action,
        processingClass: safe.processingClass,
        consentOutcome: safe.consentOutcome,
      }]
      : [{
        ordinal: contentOrdinal(safe.assetId),
        contentClass: safe.contentClass,
        action: safe.action,
        extractionAttempted: safe.extractionAttempted,
        extractionSucceeded: safe.extractionSucceeded,
        ...(safe.pages ? { pages: safe.pages } : {}),
        truncated: safe.truncated,
        ocrRequired: safe.ocrRequired,
      }];
  });
  if (content.length === 0) {
    const declaration = PORTABLE_UNAVAILABLE.find((entry) => entry.field === 'content.receipts');
    declareUnavailable('content.receipts', declaration?.reason ?? 'No bounded rich-content receipt was recorded for this run.');
  }
  const verdictResolution = latestRunVerdictResolution(run);
  const humanVerdict = verdictResolution.status === 'accepted' ? verdictResolution.verdict : undefined;
  if (verdictResolution.status === 'withheld') {
    declareUnavailable('verdict', describeRunVerdictWithholding(verdictResolution.reason));
  }
  const portableVerdict = humanVerdict
    ? {
      value: humanVerdict.verdict,
      approver: approverAlias(humanVerdict.approverId),
      recordedAt: humanVerdict.recordedAt,
      unresolvedItemCount: humanVerdict.unresolvedItems.length,
    }
    : undefined;
  const retained = PORTABLE_RETAINED.filter((entry) => {
    if (entry.field === 'delegation.changedFiles') {
      return delegations.some((delegation) => delegation.changedFiles !== undefined);
    }
    if (entry.field === 'delegation.diffDigest') {
      return delegations.some((delegation) => delegation.diffDigest !== undefined);
    }
    if (entry.field === 'content.receipts') {
      return content.length > 0;
    }
    return true;
  });

  return {
    version: PORTABLE_RUN_EVIDENCE_VERSION,
    runId: run.id,
    coordinator,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    ...(run.closeoutCompletionState ? { closeoutCompletionState: run.closeoutCompletionState } : {}),
    exportedAt,
    accounting: {
      dispatched: run.delegations.length,
      settled: run.delegations.filter((d) => d.state === 'settled').length,
      cancelled: run.delegations.filter((d) => d.state === 'cancelled').length,
      refusedBeforeDispatch: run.refusedDispatches.length,
      noExecutor: run.refusedDispatches.filter((refusal) => refusal.taskState === 'no-executor').length,
      dispositionsByKind,
    },
    permissions: run.permissions.map((event) => ({
      kind: event.kind,
      agent: alias(event.agentId),
      decision: event.decision,
      recordedAt: event.recordedAt,
      ...(isContemporaneousApprover(event.kind, event.approverId)
        ? { approver: approverAlias(event.approverId) }
        : {}),
    })),
    outcomeRepairs: run.outcomeRepairs.filter(isPortableOutcomeRepair).map((event) => ({
      category: event.category,
      state: event.state,
    })),
    ...(portableVerdict ? { verdict: portableVerdict } : {}),
    delegations,
    ...(content.length > 0 ? { content } : {}),
    omitted: {
      excluded: PORTABLE_EXCLUSIONS,
      unavailable: [
        ...(run.permissions.some((event) => !isContemporaneousApprover(event.kind, event.approverId))
          ? PORTABLE_UNAVAILABLE.filter((entry) => entry.field === 'permission.approver')
          : []),
        ...unavailable,
      ],
    },
    retained,
  };
}

/** Re-validate this new public vocabulary at export as well as on ledger restore. */
function isPortableOutcomeRepair(event: unknown): event is NonNullable<RunRecord['outcomeRepairs']>[number] {
  const repair = event as { category?: unknown; state?: unknown } | undefined;
  return !!repair &&
    (repair.category === 'consent-timeout' || repair.category === 'delegate-empty') &&
    (repair.state === 'offered' || repair.state === 'invoked' || repair.state === 'unavailable');
}

/** Stable, diffable JSON. The artifact is meant to be attached to a review, so byte stability matters. */
export function renderPortableRunEvidence(
  run: RunRecord,
  optionsOrExportedAt: PortableRunEvidenceOptions | string = {},
): string {
  return `${JSON.stringify(buildPortableRunEvidence(run, optionsOrExportedAt), null, 2)}\n`;
}
