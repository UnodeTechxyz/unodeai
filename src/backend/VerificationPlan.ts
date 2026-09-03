/*---------------------------------------------------------------------------------------------
 *  UnodeAi - per-task verification plans
 *
 *  A plan is a host-observed contract selected before a delegated task starts.  It deliberately
 *  contains sensor kinds only: commands and model prose never become part of the durable/portable
 *  contract.
 *--------------------------------------------------------------------------------------------*/

import type { DelegationTurnEvidence } from './AgentBackend';

export const VERIFICATION_SENSOR_KINDS = [
  'command-exit-zero',
  'editor-diagnostics-clean',
  'recorded-file-effect',
  'run-checks',
] as const;

export type VerificationSensorKind = typeof VERIFICATION_SENSOR_KINDS[number];

/** An empty ordered set is an explicit, valid statement that this task has no applicable sensor. */
export interface VerificationPlan {
  sensors: VerificationSensorKind[];
  noneApplies: 'report-no-applicable-sensor';
}

export type VerificationPlanStatus =
  | 'not-declared'
  | 'no-applicable-sensor'
  | 'satisfied'
  | 'not-run'
  | 'failed';

export interface VerificationPlanEvaluation {
  status: VerificationPlanStatus;
  sensors: Array<{ kind: VerificationSensorKind; status: 'passed' | 'not-run' | 'failed' }>;
}

const SENSOR_SET = new Set<string>(VERIFICATION_SENSOR_KINDS);

/**
 * Parse a model/tool supplied declaration defensively. The contract has no command or prose field on
 * purpose: the host's existing command policy remains the only way a command can execute.
 */
export function parseVerificationPlan(value: unknown): { plan?: VerificationPlan; error?: string } {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'verification_plan must be an object.' };
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== 'sensors' && key !== 'none_applies')) {
    return { error: 'verification_plan may contain only sensors and none_applies.' };
  }
  if (!Array.isArray(raw.sensors)) {
    return { error: 'verification_plan.sensors must be an ordered array.' };
  }
  const sensors: VerificationSensorKind[] = [];
  for (const sensor of raw.sensors) {
    if (typeof sensor !== 'string' || !SENSOR_SET.has(sensor)) {
      return { error: `verification_plan contains an unsupported sensor: ${String(sensor)}.` };
    }
    if (sensors.includes(sensor as VerificationSensorKind)) {
      return { error: `verification_plan repeats sensor "${sensor}".` };
    }
    sensors.push(sensor as VerificationSensorKind);
  }
  if (raw.none_applies !== 'report-no-applicable-sensor') {
    return { error: 'verification_plan.none_applies must be "report-no-applicable-sensor".' };
  }
  return { plan: { sensors, noneApplies: 'report-no-applicable-sensor' } };
}

/** A persisted plan is already host-selected; still normalize it before exposing it to evidence. */
export function sanitizeVerificationPlan(value: unknown): VerificationPlan | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.sensors) || raw.noneApplies !== 'report-no-applicable-sensor') {
    return undefined;
  }
  const sensors = raw.sensors.filter((sensor): sensor is VerificationSensorKind =>
    typeof sensor === 'string' && SENSOR_SET.has(sensor)
  );
  if (sensors.length !== raw.sensors.length || new Set(sensors).size !== sensors.length) {
    return undefined;
  }
  return { sensors, noneApplies: 'report-no-applicable-sensor' };
}

/** Evaluate only evidence the host recorded while the task was running. */
export function evaluateVerificationPlan(
  plan: VerificationPlan | undefined,
  evidence: DelegationTurnEvidence | undefined,
): VerificationPlanEvaluation {
  if (!plan) {
    return { status: 'not-declared', sensors: [] };
  }
  if (plan.sensors.length === 0) {
    return { status: 'no-applicable-sensor', sensors: [] };
  }
  const verification = evidence?.verification;
  const diagnostics = evidence?.diagnostics;
  const sensors = plan.sensors.map((kind) => {
    switch (kind) {
      case 'recorded-file-effect':
        return {
          kind,
          status: (evidence?.changedFiles.length ?? 0) > 0 && evidence?.unrecordedWrites !== true
            ? 'passed' as const : 'not-run' as const,
        };
      case 'editor-diagnostics-clean':
        return {
          kind,
          status: diagnostics?.observed
            ? (diagnostics.clean ? 'passed' as const : 'failed' as const)
            : 'not-run' as const,
        };
      case 'run-checks':
        return {
          kind,
          status: verification?.source === 'run-checks'
            ? (verification.passed ? 'passed' as const : 'failed' as const)
            : 'not-run' as const,
        };
      case 'command-exit-zero':
        return {
          kind,
          status: verification?.source === 'command-exit-zero'
            ? (verification.passed ? 'passed' as const : 'failed' as const)
            : 'not-run' as const,
        };
    }
  });
  if (sensors.some((sensor) => sensor.status === 'failed')) {
    return { status: 'failed', sensors };
  }
  if (sensors.some((sensor) => sensor.status === 'not-run')) {
    return { status: 'not-run', sensors };
  }
  return { status: 'satisfied', sensors };
}

/** Compact, content-free wording for coordinator and evidence surfaces. */
export function formatVerificationPlan(plan: VerificationPlan | undefined): string {
  if (!plan) {
    return 'legacy workspace verification policy';
  }
  return plan.sensors.length === 0
    ? 'no applicable sensor (declared before the task started)'
    : plan.sensors.join(', ');
}
