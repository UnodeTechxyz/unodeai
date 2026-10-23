/**
 * Harness Lab A/B comparison driver.
 *
 * A configuration is data supplied to the real Tier 1/2 drivers. The `implementation` axis selects the
 * two registered edit-tool surfaces for the named P1 Tier 1 mechanism probe; it never reaches Tier 2.
 * The runner records every arm's order and reports raw counts beside a delta
 * so an N=5 difference cannot be mistaken for a stable capability result. Tier 2 is callable only by an
 * explicit caller that has already supplied routes and N; importing this module never starts a backend.
 */

import { readFile } from 'fs/promises';
import * as path from 'path';
import { HarnessLabConfiguration, HarnessLabConfigurationAxis, assertHarnessLabConfiguration, harnessLabConfigurationAxes } from './labConfiguration';
import { runTier1Task, Tier1RunOptions, Tier1RunRecord } from './runner';
import { sensorA4 } from './sensors';
import { HARNESS_TASK_SET } from './taskSet';
import { parseBoundedAnswer, runTier2Task, Tier2Route, Tier2RunOptions, Tier2RunRecord } from './tier2';
import { ProjectKnowledge } from '../session/ProjectKnowledge';
import { RulesFile, rulesFilePath } from '../session/RulesFile';

type ComparisonRecord = Tier1RunRecord | Tier2RunRecord;
export type ComparisonSide = 'left' | 'right';

export interface HarnessABRunRecord {
  readonly schemaVersion: 1;
  readonly type: 'harness-ab-run';
  /** Global order proves that paired arms were interleaved instead of batch-run. */
  readonly order: number;
  /** Same task/run pair shared by its two adjacent configuration records. */
  readonly pair: number;
  readonly side: ComparisonSide;
  readonly configuration: {
    readonly name: string;
    readonly configuredAxes: readonly HarnessLabConfigurationAxis[];
    readonly appliedAxes: readonly HarnessLabConfigurationAxis[];
    readonly notApplicableAxes: readonly HarnessLabConfigurationAxis[];
  };
  readonly record: ComparisonRecord;
}

interface OutcomeCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly crashed: number;
  readonly invalid: number;
  readonly passRate: number | null;
}

interface CostMeasurement {
  /** Tier 2 task records considered for this arm. */
  readonly totalRuns: number;
  /** Runs with an actually reported value; zero is a measurement, null is not. */
  readonly observedRuns: number;
  /** Arithmetic mean across observed runs, or null when no route reported this field. */
  readonly mean: number | null;
}

interface CostComparison {
  readonly left: CostMeasurement;
  readonly right: CostMeasurement;
  /** Right mean minus left mean; null if either arm's measurement is unavailable. */
  readonly delta: number | null;
}

export interface HarnessABSummary {
  readonly schemaVersion: 1;
  readonly type: 'harness-ab-summary';
  readonly left: string;
  readonly right: string;
  readonly total: number;
  readonly noiseFloor: {
    readonly method: 'raw-per-task-counts';
    readonly note: string;
  };
  /** Tier 2 model/provider metrics only. Tier 1 and an unspent Tier 2 authorization emit null, never zero. */
  readonly cost: {
    readonly perProviderTurnTokens: CostComparison;
    readonly taskTokens: CostComparison;
    readonly taskCostUsd: CostComparison;
    readonly note: string;
  };
  readonly perTask: Readonly<Record<string, {
    readonly left: OutcomeCounts;
    readonly right: OutcomeCounts;
    /** right pass rate minus left pass rate; null if either side has no observations. */
    readonly passRateDelta: number | null;
    /** Different fixtures are allowed only for a labelled instrument demonstration, not a capability claim. */
    readonly fixturesMatch: boolean;
  }>>;
}

export interface HarnessABResult {
  readonly records: readonly HarnessABRunRecord[];
  readonly summary: HarnessABSummary;
}

/**
 * P2's no-spend arm witness. It runs the installed full and progressive context assemblers over the same
 * checked-in packet. It proves the arms differ before Tier 2 authorization is spent; it is not a model
 * quality or cost result.
 */
export interface ProjectKnowledgeABProbe {
  readonly schemaVersion: 1;
  readonly type: 'harness-ab-project-knowledge-probe';
  readonly source: 'controlled-context-assembly';
  readonly fixture: string;
  readonly left: { readonly configuration: string; readonly disclosure: 'full' | 'progressive'; readonly contextBytes: number };
  readonly right: { readonly configuration: string; readonly disclosure: 'full' | 'progressive'; readonly contextBytes: number };
  readonly contextByteDelta: number;
  readonly armsDiffer: boolean;
  readonly note: string;
}

/** Run deterministic Tier 1 tasks under each configuration in alternating pair order. */
export async function runTier1AB(
  left: HarnessLabConfiguration,
  right: HarnessLabConfiguration,
  options: Omit<Tier1RunOptions, 'configuration'> = {},
): Promise<HarnessABResult> {
  validatePair(left, right);
  const records: HarnessABRunRecord[] = [];
  let order = 0;
  let pair = 0;
  for (const [taskIndex, task] of tier1ComparisonTasks(left, right).entries()) {
    pair++;
    for (const { side, configuration } of interleavedPair(left, right, taskIndex)) {
      const record = await runTier1Task(task.id, { ...options, configuration });
      records.push(wrapRecord(++order, pair, side, configuration, record));
    }
  }
  return { records, summary: summarizeAB(left, right, records) };
}

/**
 * Run every real Tier 2 task for two configurations. This is serial and alternates A/B then B/A
 * across pairs to reduce route-load and latency drift. Callers must provide both selected routes and N.
 */
export async function runTier2AB(
  left: HarnessLabConfiguration,
  right: HarnessLabConfiguration,
  routes: readonly Tier2Route[],
  n: number,
  options: Omit<Tier2RunOptions, 'route' | 'run' | 'configuration'> = {},
): Promise<HarnessABResult> {
  validatePair(left, right);
  if (left.implementation !== undefined || right.implementation !== undefined) {
    throw new Error('Implementation comparisons are Tier 1-only; Tier 2 must not spend on an unapplied branch.');
  }
  if (routes.length === 0 || !Number.isInteger(n) || n <= 0) {
    throw new Error('Tier 2 A/B requires explicitly selected routes and a positive integer N.');
  }
  const records: HarnessABRunRecord[] = [];
  let order = 0;
  let pair = 0;
  let alternation = 0;
  for (const route of routes) {
    for (let run = 1; run <= n; run++) {
      for (const task of HARNESS_TASK_SET.filter((candidate) => candidate.tier === 2)) {
        pair++;
        for (const { side, configuration } of interleavedPair(left, right, alternation++)) {
          const record = await runTier2Task(task.id, { ...options, route, run, configuration });
          records.push(wrapRecord(++order, pair, side, configuration, record, route));
        }
      }
    }
  }
  return { records, summary: summarizeAB(left, right, records) };
}

/** Read and validate a named comparison arm. Configuration files contain no credentials or routes. */
export async function readHarnessLabConfiguration(file: string): Promise<HarnessLabConfiguration> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read Harness Lab configuration ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertHarnessLabConfiguration(raw as HarnessLabConfiguration);
  return raw as HarnessLabConfiguration;
}

/** Assemble both P2 arms without a backend, route, credential, or model call. */
export async function runProjectKnowledgeABProbe(
  left: HarnessLabConfiguration,
  right: HarnessLabConfiguration,
  repoRoot = process.cwd(),
): Promise<ProjectKnowledgeABProbe> {
  validatePair(left, right);
  const leftDisclosure = left.projectKnowledgeDisclosure;
  const rightDisclosure = right.projectKnowledgeDisclosure;
  if (!leftDisclosure || !rightDisclosure || leftDisclosure === rightDisclosure) {
    throw new Error('The project-knowledge probe requires two distinct explicit projectKnowledgeDisclosure arms.');
  }
  const fixture = 'src/harness/fixtures/P2-project-knowledge';
  const root = path.resolve(repoRoot, fixture);
  const [leftContext, rightContext] = await Promise.all([
    assembleProjectKnowledgeContext(root, leftDisclosure),
    assembleProjectKnowledgeContext(root, rightDisclosure),
  ]);
  const leftBytes = Buffer.byteLength(leftContext, 'utf8');
  const rightBytes = Buffer.byteLength(rightContext, 'utf8');
  return {
    schemaVersion: 1,
    type: 'harness-ab-project-knowledge-probe',
    source: 'controlled-context-assembly',
    fixture,
    left: { configuration: left.name, disclosure: leftDisclosure, contextBytes: leftBytes },
    right: { configuration: right.name, disclosure: rightDisclosure, contextBytes: rightBytes },
    contextByteDelta: rightBytes - leftBytes,
    armsDiffer: leftContext !== rightContext,
    note: 'Controlled context-assembly witness only: it proves the installed full and progressive arms differ. It makes no model-quality, per-turn-token, or task-cost claim; those remain null until an authorized Tier 2 run reports usage.',
  };
}

/** Shared by the P2 probe and Tier 2 once an explicit authorization chooses an arm. */
export async function assembleProjectKnowledgeContext(root: string, disclosure: 'full' | 'progressive'): Promise<string> {
  const rules = new RulesFile(rulesFilePath(root));
  const knowledge = new ProjectKnowledge(root);
  await Promise.all([rules.load(), knowledge.load()]);
  return disclosure === 'full'
    ? [rules.getRepositoryContext(), knowledge.fullPromptBlock()].filter(Boolean).join('\n\n')
    : [rules.getRepositorySummaryContext(), knowledge.promptBlock()].filter(Boolean).join('\n\n');
}

export interface A4FixtureRepairDemo {
  readonly schemaVersion: 1;
  readonly type: 'harness-ab-fixture-repair-demo';
  readonly source: 'controlled-instrument-self-test';
  readonly left: {
    readonly configuration: string;
    readonly fixture: string;
    readonly outcome: 'failed';
    readonly sensorReason: string;
  };
  readonly right: {
    readonly configuration: string;
    readonly fixture: string;
    readonly outcome: 'passed';
    readonly sensorReason: string;
  };
  readonly passRateDelta: 1;
  readonly note: string;
}

/**
 * Demonstrate the known A4 fixture/sensor repair without a model call or a baseline rescore.
 * The exact same synthetic reply contains explanatory prose and a correct structured answer: the
 * v0.9.38 whole-reply comparator fails it; the repaired extractor passes it. This is an instrument
 * self-test, not a model result and therefore is kept distinct from `runTier2AB` evidence.
 */
export async function runA4FixtureRepairDemo(
  left: HarnessLabConfiguration,
  right: HarnessLabConfiguration,
  repoRoot = process.cwd(),
): Promise<A4FixtureRepairDemo> {
  validatePair(left, right);
  const legacyFixture = left.fixtureOverrides?.A4;
  const repairedFixture = right.fixtureOverrides?.A4 ?? 'src/harness/fixtures/A4';
  if (!legacyFixture) {
    throw new Error('The left A4 repair-demo configuration must select a retained v0.9.38 A4 fixture.');
  }
  const [legacyTask, repairedTask] = await Promise.all([
    readFile(path.resolve(repoRoot, legacyFixture, 'task.md'), 'utf8'),
    readFile(path.resolve(repoRoot, repairedFixture, 'task.md'), 'utf8'),
  ]);
  if (legacyTask.includes('ANSWER:') || !repairedTask.includes('ANSWER:')) {
    throw new Error('A4 repair demo fixtures do not preserve the broken/repaired task contracts.');
  }
  const reply = 'I read alpha.txt, beta.txt, and gamma.txt.\nANSWER: violet-orbit-17';
  const legacy = sensorA4({ answer: reply.trim(), expectedAnswer: 'violet-orbit-17' });
  const repaired = sensorA4({ answer: parseBoundedAnswer(reply), expectedAnswer: 'violet-orbit-17' });
  if (legacy.passed || !repaired.passed) {
    throw new Error('A4 repair demo did not produce its known inert direction.');
  }
  return {
    schemaVersion: 1,
    type: 'harness-ab-fixture-repair-demo',
    source: 'controlled-instrument-self-test',
    left: { configuration: left.name, fixture: legacyFixture, outcome: 'failed', sensorReason: legacy.reason },
    right: { configuration: right.name, fixture: repairedFixture, outcome: 'passed', sensorReason: repaired.reason },
    passRateDelta: 1,
    note: 'Controlled fixture/sensor validation only: no model was invoked, and the v0.9.38 baseline remains unrescored.',
  };
}

function validatePair(left: HarnessLabConfiguration, right: HarnessLabConfiguration): void {
  assertHarnessLabConfiguration(left);
  assertHarnessLabConfiguration(right);
  if (left.name === right.name) {
    throw new Error('A/B configurations must have different names.');
  }
  if (left.implementation !== undefined || right.implementation !== undefined) {
    if (left.implementation === undefined || right.implementation === undefined || left.implementation === right.implementation) {
      throw new Error('An implementation comparison requires two distinct registered implementations.');
    }
  }
  if (sameEffectiveAxes(left, right)) {
    throw new Error('A/B configurations need a genuinely different effective axis; different names alone are a null experiment.');
  }
}

/** P1 is meaningful only when a pair explicitly selects the two edit implementations. */
function tier1ComparisonTasks(left: HarnessLabConfiguration, right: HarnessLabConfiguration) {
  const includeDialectProbe = left.implementation !== undefined && right.implementation !== undefined;
  return HARNESS_TASK_SET.filter((candidate) => candidate.tier === 1 && (candidate.id !== 'P1' || includeDialectProbe));
}

function interleavedPair(
  left: HarnessLabConfiguration,
  right: HarnessLabConfiguration,
  index: number,
): Array<{ side: ComparisonSide; configuration: HarnessLabConfiguration }> {
  return index % 2 === 0
    ? [{ side: 'left', configuration: left }, { side: 'right', configuration: right }]
    : [{ side: 'right', configuration: right }, { side: 'left', configuration: left }];
}

function wrapRecord(
  order: number,
  pair: number,
  side: ComparisonSide,
  configuration: HarnessLabConfiguration,
  record: ComparisonRecord,
  route?: Tier2Route,
): HarnessABRunRecord {
  const configuredAxes = harnessLabConfigurationAxes(configuration);
  const notApplicableAxes = record.tier === 1
    ? configuredAxes.filter((axis) => axis !== 'commandAllowlist' && !(axis === 'implementation' && record.taskId === 'P1'))
    : configuredAxes.filter((axis) => axis === 'implementation' || (axis === 'toolProtocol' && route?.route.kind === 'claude-headless'));
  return {
    schemaVersion: 1,
    type: 'harness-ab-run',
    order,
    pair,
    side,
    configuration: {
      name: configuration.name,
      configuredAxes,
      appliedAxes: configuredAxes.filter((axis) => !notApplicableAxes.includes(axis)),
      notApplicableAxes,
    },
    record,
  };
}

function summarizeAB(
  left: HarnessLabConfiguration,
  right: HarnessLabConfiguration,
  records: readonly HarnessABRunRecord[],
): HarnessABSummary {
  const perTask: Record<string, HarnessABSummary['perTask'][string]> = {};
  for (const taskId of new Set(records.map((entry) => entry.record.taskId))) {
    const leftRecords = records.filter((entry) => entry.side === 'left' && entry.record.taskId === taskId).map((entry) => entry.record);
    const rightRecords = records.filter((entry) => entry.side === 'right' && entry.record.taskId === taskId).map((entry) => entry.record);
    const leftCounts = outcomeCounts(leftRecords);
    const rightCounts = outcomeCounts(rightRecords);
    perTask[taskId] = {
      left: leftCounts,
      right: rightCounts,
      passRateDelta: leftCounts.passRate === null || rightCounts.passRate === null ? null : rightCounts.passRate - leftCounts.passRate,
      fixturesMatch: sameValues(leftRecords.map((record) => record.fixture), rightRecords.map((record) => record.fixture)),
    };
  }
  return {
    schemaVersion: 1,
    type: 'harness-ab-summary',
    left: left.name,
    right: right.name,
    total: records.length,
    noiseFloor: {
      method: 'raw-per-task-counts',
      note: 'One outcome changes an arm\'s pass rate by 1/N for that task. Treat a delta as a hypothesis until its per-task counts are replicated; this report intentionally supplies no confidence claim.',
    },
    cost: {
      perProviderTurnTokens: compareCosts(records, (record) => {
        const input = record.metrics.inputTokens;
        const output = record.metrics.outputTokens;
        const turns = record.metrics.providerTurns;
        return input === null || input === undefined || output === null || output === undefined || !turns
          ? null
          : (input + output) / turns;
      }),
      taskTokens: compareCosts(records, (record) => record.metrics.taskTokens ?? null),
      taskCostUsd: compareCosts(records, (record) => record.metrics.taskCostUsd ?? null),
      note: 'These fields use only provider-reported Tier 2 usage and SessionManager task attribution. They remain null when no authorized Tier 2 route ran or a route supplied no usage; null is not a zero-cost result.',
    },
    perTask,
  };
}

function outcomeCounts(records: readonly ComparisonRecord[]): OutcomeCounts {
  const total = records.length;
  const count = (outcome: ComparisonRecord['outcome']) => records.filter((record) => record.outcome === outcome).length;
  const passed = count('passed');
  return { total, passed, failed: count('failed'), crashed: count('crashed'), invalid: count('invalid'), passRate: total === 0 ? null : passed / total };
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareCosts(
  records: readonly HarnessABRunRecord[],
  select: (record: Tier2RunRecord) => number | null,
): CostComparison {
  const measure = (side: ComparisonSide): CostMeasurement => {
    const tier2 = records.filter((entry): entry is HarnessABRunRecord & { record: Tier2RunRecord } => entry.side === side && entry.record.tier === 2);
    const values = tier2.map((entry) => select(entry.record)).filter((value): value is number => value !== null && Number.isFinite(value));
    return {
      totalRuns: tier2.length,
      observedRuns: values.length,
      mean: values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : null,
    };
  };
  const left = measure('left');
  const right = measure('right');
  return { left, right, delta: left.mean === null || right.mean === null ? null : right.mean - left.mean };
}

function sameEffectiveAxes(left: HarnessLabConfiguration, right: HarnessLabConfiguration): boolean {
  const { name: _leftName, ...leftAxes } = left;
  const { name: _rightName, ...rightAxes } = right;
  return stableJson(leftAxes) === stableJson(rightAxes);
}

/** Configuration object key order is not an experimental variable. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
