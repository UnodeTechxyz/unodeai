// The auxiliary mutation groups: the harness sensors and the shared-memory trust proof. This file is their
// definition: which ids each group holds, and how a run of its proof script is read. The proof scripts, the CI
// wrappers and the final aggregator all take it from here, so a runner and the aggregator read one definition.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export const SENSOR_SOURCE = 'src/harness/sensors.ts';
export const SENSOR_SUITE = 'src/harness/__tests__/taskSet.test.ts';
export const SHARED_MEMORY = {
  id: 'shared-memory:trust-priority',
  source: 'src/session/SharedMemory.ts',
  killedLine: 'killed: agent-selected contract cannot regain trust/admission priority',
};

/**
 * Every Requirement.met initializer in the sensor source, with the anchor that replaces it by `true`. The syntax
 * tree finds property assignments rather than matching line text: an object whose brace and `met` property sit on
 * different lines is still found.
 */
export function sensorRequirements(sourceText) {
  const sourceFile = ts.createSourceFile(SENSOR_SOURCE, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const requirements = [];

  function visit(node) {
    if (
      ts.isPropertyAssignment(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'met'
      && ts.isObjectLiteralExpression(node.parent)
    ) {
      const idProperty = node.parent.properties.find((property) =>
        ts.isPropertyAssignment(property)
        && ts.isIdentifier(property.name)
        && property.name.text === 'id'
      );
      const reasonProperty = node.parent.properties.find((property) =>
        ts.isPropertyAssignment(property)
        && ts.isIdentifier(property.name)
        && property.name.text === 'reason'
      );
      if (!idProperty || !ts.isPropertyAssignment(idProperty) || !ts.isStringLiteral(idProperty.initializer)) {
        throw new Error('Requirement at offset ' + node.getStart(sourceFile) + ' has no string-literal id.');
      }
      if (!reasonProperty || !ts.isPropertyAssignment(reasonProperty) || !ts.isStringLiteral(reasonProperty.initializer)) {
        throw new Error('Requirement at offset ' + node.getStart(sourceFile) + ' has no string-literal reason.');
      }
      const objectStart = node.parent.getStart(sourceFile);
      const objectEnd = node.parent.end;
      const anchor = sourceText.slice(objectStart, objectEnd);
      const initializerStart = node.initializer.getStart(sourceFile) - objectStart;
      const initializerEnd = node.initializer.end - objectStart;
      requirements.push({
        id: idProperty.initializer.text,
        reason: reasonProperty.initializer.text,
        from: anchor,
        to: `${anchor.slice(0, initializerStart)}true${anchor.slice(initializerEnd)}`,
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return requirements;
}

function sensorIds(root) {
  const ids = sensorRequirements(readFileSync(join(root, SENSOR_SOURCE), 'utf8')).map((requirement) => `sensor:${requirement.id}`);
  if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error('Sensor requirement ids must be unique and non-empty.');
  return ids;
}

// The sensor script prints one line per requirement: `killed`, `SURVIVED` or `INVALID`, a number, the id in brackets.
function judgeSensorRun(root, run) {
  const ids = sensorIds(root);
  const known = new Set(ids);
  const reported = new Map();
  for (const line of run.stdout.split(/\r?\n/)) {
    const match = /^(killed|SURVIVED|INVALID)\s+\d+\s+\[([^\]]+)\]/.exec(line);
    if (!match) continue;
    const id = `sensor:${match[2]}`;
    if (!known.has(id)) throw new Error(`Sensor run reported ${id}, which the sensor source does not define.`);
    if (reported.has(id)) throw new Error(`Sensor run reported ${id} more than once.`);
    reported.set(id, match[1].toLowerCase());
  }
  const cases = ids.map((id) => reported.has(id)
    ? { id, verdict: reported.get(id) }
    : { id, verdict: 'invalid', reason: 'the sensor script reported no verdict for this requirement' });
  const problems = [];
  if (run.code !== 0) problems.push(`the sensor script exited ${run.code}`);
  const summary = /every sensor requirement mutant killed \((\d+)\/(\d+)\)/.exec(run.stdout);
  const killed = cases.filter((entry) => entry.verdict === 'killed').length;
  if (run.code === 0 && (!summary || Number(summary[1]) !== killed || Number(summary[2]) !== ids.length)) {
    problems.push('the sensor script summary disagrees with its per-requirement verdicts');
  }
  return { cases, problems };
}

function judgeSharedMemoryRun(_root, run) {
  const output = `${run.stdout}\n${run.stderr}`;
  const verdict = run.code === 0 && run.stdout.includes(SHARED_MEMORY.killedLine) ? 'killed'
    : output.includes('SURVIVED:') ? 'survived'
      : 'invalid';
  return {
    cases: [{ id: SHARED_MEMORY.id, verdict, ...(verdict === 'invalid' ? { reason: 'the shared-memory script did not report its kill' } : {}) }],
    problems: run.code === 0 ? [] : [`the shared-memory script exited ${run.code}`],
  };
}

/** `source` is the file each group mutates. Its digest is what a receipt records as the group's manifest digest. */
export const AUXILIARY_GROUPS = [
  { key: 'sensors', script: 'scripts/check-harness-sensor-mutations.mjs', source: SENSOR_SOURCE, ids: sensorIds, judge: judgeSensorRun },
  {
    key: 'shared-memory',
    script: 'scripts/check-shared-memory-trust-mutations.mjs',
    source: SHARED_MEMORY.source,
    ids: () => [SHARED_MEMORY.id],
    judge: judgeSharedMemoryRun,
  },
];

export const fileSha256 = (root, file) => createHash('sha256').update(readFileSync(join(root, file))).digest('hex');

/**
 * Run one auxiliary group's proof script and return its receipt group. `runScript(script)` resolves to
 * `{ code, stdout, stderr }`. The population comes from the definitions above, never from what the script printed;
 * `problems` is non-empty when the run cannot be trusted even though every verdict reads as a kill.
 */
export async function runAuxiliaryGroup(root, group, runScript) {
  const started = Date.now();
  const populationIds = group.ids(root);
  const run = await runScript(group.script);
  const { cases, problems } = group.judge(root, run);
  return {
    name: group.key,
    shard: null,
    manifestSha256: fileSha256(root, group.source),
    populationIds,
    admittedIds: populationIds,
    killedIds: cases.filter((entry) => entry.verdict === 'killed').map((entry) => entry.id),
    cases,
    problems,
    durationMs: Date.now() - started,
  };
}
