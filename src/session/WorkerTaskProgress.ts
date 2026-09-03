/*---------------------------------------------------------------------------------------------
 *  Phase A worker-task progress observation.
 *
 *  This module only records host-observed events. It deliberately makes no scheduling, timeout,
 *  cancellation, retry, or model-selection decision.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import type { DelegationTurnEvidence, TurnResult } from '../backend/AgentBackend';
import type { AgentBackendKind } from '../types';

/** The persisted sequence is bounded; the tracker still counts every tool call and material event. */
const MAX_RETAINED_FINGERPRINTS = 1_000;

export const LONG_TASK_THRESHOLDS_MS = [2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000] as const;
/** A pair of non-overlapping single observations is arithmetic, not evidence of a useful separation. */
export const MIN_COHORT_SIZE_FOR_SEPARATION = 8;

export type WorkerTaskProgressOutcome = 'framework-evidenced-output' | 'no-framework-evidence';
export type ProgressSeparationAssessment =
  | 'insufficient-data'
  | 'evidenced-below-no-evidence'
  | 'overlap-or-reversed';

/**
 * One completed correlated worker turn. Fingerprints contain a tool name and a one-way digest of
 * normalized arguments; neither raw arguments nor tool output are persisted here.
 */
export interface WorkerTaskProgressRecord {
  schemaVersion: 1;
  correlationId: string;
  agentId: string;
  backend: AgentBackendKind;
  model: string;
  startedAt: string;
  settledAt: string;
  durationMs: number;
  modelRequests: number;
  toolCalls: number;
  inputTokens?: number;
  inputTokensEstimated?: boolean;
  /** Every retained fingerprint is `${tool-name}:${sha256(normalized arguments).slice(0, 16)}`. */
  fingerprintSequence: string[];
  droppedFingerprintCount: number;
  materialProgressCount: number;
  lastMaterialProgressAt: string;
  /** The primary Phase A measurement: max gap from start / one material event to the next / settlement. */
  longestNoMaterialProgressMs: number;
  /** This is evidence terminology, not a model judgement of prose quality. */
  outcome: WorkerTaskProgressOutcome;
  hasFinalReply: boolean;
  terminalState: 'completed' | 'error-or-unresolved';
}

export interface WorkerProgressCohortDistribution {
  count: number;
  /** Nearest-rank quantiles; deliberately no arithmetic mean. */
  noMaterialProgressMs: {
    min?: number;
    p50?: number;
    p75?: number;
    p90?: number;
    p95?: number;
    max?: number;
  };
  buckets: Array<{ label: string; count: number }>;
}

export interface WorkerTaskProgressDistribution {
  minDurationMs: number;
  includedTasks: number;
  frameworkEvidencedOutput: WorkerProgressCohortDistribution;
  noFrameworkEvidence: WorkerProgressCohortDistribution;
  /** A threshold is defensible only when this is `evidenced-below-no-evidence`, never from a mean. */
  separation: ProgressSeparationAssessment;
}

interface ActiveWorkerTaskProgress {
  correlationId: string;
  agentId: string;
  backend: AgentBackendKind;
  model: string;
  startedAtMs: number;
  lastMaterialProgressAtMs: number;
  longestNoMaterialProgressMs: number;
  modelRequests: number;
  toolCalls: number;
  materialProgressCount: number;
  fingerprints: string[];
  droppedFingerprintCount: number;
  seenToolFingerprints: Set<string>;
  seenChangedFiles: Set<string>;
  seenVerificationResults: Set<string>;
}

export class WorkerTaskProgressTracker {
  private active = new Map<string, ActiveWorkerTaskProgress>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  begin(input: {
    sessionId: string;
    correlationId: string;
    agentId: string;
    backend: AgentBackendKind;
    model: string;
  }): void {
    const startedAtMs = this.now();
    this.active.set(input.sessionId, {
      ...input,
      startedAtMs,
      lastMaterialProgressAtMs: startedAtMs,
      longestNoMaterialProgressMs: 0,
      modelRequests: 0,
      toolCalls: 0,
      materialProgressCount: 0,
      fingerprints: [],
      droppedFingerprintCount: 0,
      seenToolFingerprints: new Set(),
      seenChangedFiles: new Set(),
      seenVerificationResults: new Set(),
    });
  }

  noteModelRequest(sessionId: string): void {
    const active = this.active.get(sessionId);
    if (active) {
      active.modelRequests++;
    }
  }

  noteToolUse(sessionId: string, name: string, input: unknown): void {
    const active = this.active.get(sessionId);
    if (!active) {
      return;
    }
    active.toolCalls++;
    const fingerprint = toolFingerprint(name, input);
    if (active.fingerprints.length < MAX_RETAINED_FINGERPRINTS) {
      active.fingerprints.push(fingerprint);
    } else {
      active.droppedFingerprintCount++;
    }
    if (!active.seenToolFingerprints.has(fingerprint)) {
      active.seenToolFingerprints.add(fingerprint);
      this.noteMaterialProgress(active);
    }
  }

  noteToolResult(sessionId: string, name: string, ok: boolean): void {
    const active = this.active.get(sessionId);
    if (!active || !isVerificationTool(name)) {
      return;
    }
    // A new pass/fail verification result is meaningful; endlessly re-reporting the same result is not.
    const fingerprint = `${name.trim().toLowerCase()}:${ok ? 'passed' : 'not-passed'}`;
    if (!active.seenVerificationResults.has(fingerprint)) {
      active.seenVerificationResults.add(fingerprint);
      this.noteMaterialProgress(active);
    }
  }

  finish(sessionId: string, result: TurnResult): WorkerTaskProgressRecord | undefined {
    const active = this.active.get(sessionId);
    if (!active) {
      return undefined;
    }
    this.active.delete(sessionId);
    this.noteTerminalEvidence(active, result.delegationEvidence);
    const settledAtMs = this.now();
    active.longestNoMaterialProgressMs = Math.max(
      active.longestNoMaterialProgressMs,
      Math.max(0, settledAtMs - active.lastMaterialProgressAtMs),
    );
    const evidence = result.delegationEvidence;
    const terminalState = result.isError || result.unresolvedReason ? 'error-or-unresolved' : 'completed';
    const frameworkEvidenced = terminalState === 'completed' && (active.toolCalls > 0 || hasFrameworkEvidence(evidence));
    return {
      schemaVersion: 1,
      correlationId: active.correlationId,
      agentId: active.agentId,
      backend: active.backend,
      model: active.model,
      startedAt: new Date(active.startedAtMs).toISOString(),
      settledAt: new Date(settledAtMs).toISOString(),
      durationMs: Math.max(0, settledAtMs - active.startedAtMs),
      modelRequests: active.modelRequests,
      toolCalls: active.toolCalls,
      ...(result.usage ? { inputTokens: result.usage.inputTokens, ...(result.usage.estimated ? { inputTokensEstimated: true } : {}) } : {}),
      fingerprintSequence: active.fingerprints,
      droppedFingerprintCount: active.droppedFingerprintCount,
      materialProgressCount: active.materialProgressCount,
      lastMaterialProgressAt: new Date(active.lastMaterialProgressAtMs).toISOString(),
      longestNoMaterialProgressMs: active.longestNoMaterialProgressMs,
      outcome: frameworkEvidenced ? 'framework-evidenced-output' : 'no-framework-evidence',
      hasFinalReply: result.text.trim().length > 0,
      terminalState,
    };
  }

  private noteTerminalEvidence(active: ActiveWorkerTaskProgress, evidence: DelegationTurnEvidence | undefined): void {
    for (const path of evidence?.changedFiles ?? []) {
      const fingerprint = oneWayFingerprint('changed-file', normalizeString(path));
      if (!active.seenChangedFiles.has(fingerprint)) {
        active.seenChangedFiles.add(fingerprint);
        this.noteMaterialProgress(active);
      }
    }
    if (evidence?.verification?.ran) {
      const fingerprint = `terminal-verification:${evidence.verification.passed ? 'passed' : 'not-passed'}`;
      if (!active.seenVerificationResults.has(fingerprint)) {
        active.seenVerificationResults.add(fingerprint);
        this.noteMaterialProgress(active);
      }
    }
  }

  private noteMaterialProgress(active: ActiveWorkerTaskProgress): void {
    const observedAtMs = this.now();
    active.longestNoMaterialProgressMs = Math.max(
      active.longestNoMaterialProgressMs,
      Math.max(0, observedAtMs - active.lastMaterialProgressAtMs),
    );
    active.lastMaterialProgressAtMs = observedAtMs;
    active.materialProgressCount++;
  }
}

/** Produces a distribution suitable for a future budget decision; it intentionally has no average. */
export function deriveWorkerTaskProgressDistribution(
  records: readonly WorkerTaskProgressRecord[],
  minDurationMs: number,
): WorkerTaskProgressDistribution {
  const included = records.filter((record) => record.durationMs >= minDurationMs);
  const evidenced = included
    .filter((record) => record.outcome === 'framework-evidenced-output')
    .map((record) => record.longestNoMaterialProgressMs);
  const noEvidence = included
    .filter((record) => record.outcome === 'no-framework-evidence')
    .map((record) => record.longestNoMaterialProgressMs);
  const evidencedStats = cohortDistribution(evidenced);
  const noEvidenceStats = cohortDistribution(noEvidence);
  const separation = evidencedStats.count < MIN_COHORT_SIZE_FOR_SEPARATION || noEvidenceStats.count < MIN_COHORT_SIZE_FOR_SEPARATION
    ? 'insufficient-data'
    : (evidencedStats.noMaterialProgressMs.max ?? Infinity) < (noEvidenceStats.noMaterialProgressMs.min ?? -Infinity)
      ? 'evidenced-below-no-evidence'
      : 'overlap-or-reversed';
  return {
    minDurationMs,
    includedTasks: included.length,
    frameworkEvidencedOutput: evidencedStats,
    noFrameworkEvidence: noEvidenceStats,
    separation,
  };
}

function cohortDistribution(values: readonly number[]): WorkerProgressCohortDistribution {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    noMaterialProgressMs: sorted.length === 0 ? {} : {
      min: sorted[0],
      p50: nearestRank(sorted, 0.5),
      p75: nearestRank(sorted, 0.75),
      p90: nearestRank(sorted, 0.9),
      p95: nearestRank(sorted, 0.95),
      max: sorted.at(-1),
    },
    buckets: [
      ['<15s', 0, 15_000],
      ['15s–<1m', 15_000, 60_000],
      ['1m–<5m', 60_000, 5 * 60_000],
      ['5m–<15m', 5 * 60_000, 15 * 60_000],
      ['≥15m', 15 * 60_000, Infinity],
    ].map(([label, lower, upper]) => ({
      label: String(label),
      count: sorted.filter((value) => value >= Number(lower) && value < Number(upper)).length,
    })),
  };
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function hasFrameworkEvidence(evidence: DelegationTurnEvidence | undefined): boolean {
  return evidence?.hadToolActions === true || (evidence?.changedFiles.length ?? 0) > 0 || evidence?.verification?.ran === true;
}

function isVerificationTool(name: string): boolean {
  return /^run_checks$/i.test(name);
}

function toolFingerprint(name: string, input: unknown): string {
  return oneWayFingerprint(name.trim().toLowerCase() || 'unknown-tool', normalizeForFingerprint(input));
}

function oneWayFingerprint(label: string, value: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
  return `${label}:${digest}`;
}

function normalizeForFingerprint(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (isSensitiveKey(key)) {
      return '[redacted]';
    }
    const normalized = redactInlineSecrets(normalizeString(value));
    // Large free-form contents are never retained, even as a raw pre-image for a digest. Their length still
    // distinguishes a materially different write without creating a second secret-bearing artifact.
    return /(?:content|text|prompt|instruction|body)$/i.test(key) ? `[text:${normalized.length}]` : normalized;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForFingerprint(item));
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((entry) => [entry, normalizeForFingerprint(object[entry], entry)]));
  }
  return `[${typeof value}]`;
}

function normalizeString(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isSensitiveKey(key: string): boolean {
  return /(?:api[_-]?key|access[_-]?token|token|password|secret|authorization|cookie)/i.test(key);
}

function redactInlineSecrets(value: string): string {
  return value
    .replace(/\bauthorization\s*:\s*bearer\s+\S+/gi, 'authorization: bearer [redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|token|password|secret|authorization)\b\s*([:=])\s*[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/--(?:token|password|secret|api[_-]?key)=\S+/gi, (match) => `${match.slice(0, match.indexOf('='))}=[redacted]`)
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|password|secret)=)[^&\s]+/gi, '$1[redacted]');
}
