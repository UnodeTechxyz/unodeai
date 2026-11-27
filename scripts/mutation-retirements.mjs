// v0.9.104 D0.2 (E2, the Owner, 2026-11-15): a mutation case leaves the population only with a recorded reason.
//
// A count cannot show which cases went: one removed and one added leaves it unchanged. So the ids of the last released
// population are checked in (mutation-population-ids.json), and every id that has disappeared from this checkout's
// definitions since then must be named, exactly, by a retirement record (mutation-retirements.json): which case, the
// change that removed its code, why, and what replaces it, if anything. A case whose anchor changes gets a new id; its
// old id is retired with the new one as its replacement. The floors of mutation-ci-plan.json may not drop below the
// ones recorded with the baseline, less that group's recorded retirements. After a release, `node scripts/mutation-population-ids.mjs --write`
// records the new population and floors and empties the records, in a reviewed commit.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MUTATION_POPULATION_IDS_SCHEMA = 'unode-mutation-population-ids/v1';
export const MUTATION_RETIREMENTS_SCHEMA = 'unode-mutation-retirements/v1';
export const POPULATION_IDS_FILE = 'mutation-population-ids.json';
export const RETIREMENTS_FILE = 'mutation-retirements.json';

const isText = (value) => typeof value === 'string' && value.trim().length > 0;

function idList(value, label) {
  if (!Array.isArray(value) || value.some((id) => !isText(id))) throw new Error(`${label} must be an array of case ids.`);
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates.`);
  return value;
}

/** The checked-in baseline: one id list and one floor per group of the plan, nothing more and nothing less. */
export function validatePopulationBaseline(baseline, plan) {
  if (!baseline || baseline.schema !== MUTATION_POPULATION_IDS_SCHEMA) throw new Error(`${POPULATION_IDS_FILE} schema is missing or unsupported.`);
  if (!isText(baseline.recordedAt)) throw new Error(`${POPULATION_IDS_FILE} must say when it was recorded (recordedAt).`);
  const groups = Object.keys(plan.minimumPopulation).sort();
  for (const field of ['groups', 'minimumPopulation']) {
    const value = baseline[field];
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${POPULATION_IDS_FILE} ${field} must be an object.`);
    const keys = Object.keys(value).sort();
    if (keys.join('\n') !== groups.join('\n')) {
      throw new Error(`${POPULATION_IDS_FILE} ${field} names ${keys.join(', ') || 'no group'}, but the plan's groups are ${groups.join(', ')}.`);
    }
  }
  for (const group of groups) {
    idList(baseline.groups[group], `${POPULATION_IDS_FILE} ${group}`);
    if (!Number.isSafeInteger(baseline.minimumPopulation[group]) || baseline.minimumPopulation[group] < 1) {
      throw new Error(`${POPULATION_IDS_FILE} minimumPopulation.${group} must be a positive integer.`);
    }
  }
  return baseline;
}

/** Each record: a group of the plan, the retired ids, the change that removed their code, why, and the replacement. */
export function validateRetirements(file, plan) {
  if (!file || file.schema !== MUTATION_RETIREMENTS_SCHEMA) throw new Error(`${RETIREMENTS_FILE} schema is missing or unsupported.`);
  if (!Array.isArray(file.retirements)) throw new Error(`${RETIREMENTS_FILE} retirements must be an array.`);
  const seen = new Set();
  file.retirements.forEach((record, index) => {
    const label = `${RETIREMENTS_FILE} retirements[${index}]`;
    if (!record || typeof record !== 'object') throw new Error(`${label} must be an object.`);
    const known = new Set(['group', 'ids', 'removedBy', 'reason', 'replacement']);
    const extra = Object.keys(record).filter((key) => !known.has(key));
    if (extra.length > 0) throw new Error(`${label} has unknown fields: ${extra.join(', ')}.`);
    if (!Object.hasOwn(plan.minimumPopulation, record.group)) throw new Error(`${label} names group ${record.group}, which the plan does not have.`);
    if (idList(record.ids, `${label} ids`).length === 0) throw new Error(`${label} ids must name at least one case.`);
    for (const field of ['removedBy', 'reason']) {
      if (!isText(record[field])) throw new Error(`${label} ${field} must say ${field === 'removedBy' ? 'which change removed the code' : 'why the case is retired'}.`);
    }
    // A replacement names what judges the same boundary now, or says plainly that nothing does and why.
    if (!isText(record.replacement)) throw new Error(`${label} replacement must name the replacing case, or say why nothing replaces it.`);
    for (const id of record.ids) {
      const key = `${record.group}\n${id}`;
      if (seen.has(key)) throw new Error(`${RETIREMENTS_FILE} retires ${record.group} case ${id} more than once.`);
      seen.add(key);
    }
  });
  return file;
}

/**
 * The cases that disappeared since the baseline must be exactly the recorded ones, per group, and no floor may sit
 * below the baseline's. `populations` maps each group to this checkout's ids. Returns the retired and added counts.
 */
export function verifyRetirements({ plan, baseline, retirements, populations }) {
  validatePopulationBaseline(baseline, plan);
  validateRetirements(retirements, plan);
  const retired = {};
  const added = {};
  for (const group of Object.keys(plan.minimumPopulation)) {
    const current = new Set(populations.get(group) ?? []);
    const before = new Set(baseline.groups[group]);
    const recorded = new Set(retirements.retirements.filter((record) => record.group === group).flatMap((record) => record.ids));
    // A floor drops at most by the recorded retirements of its group.
    const floor = plan.minimumPopulation[group];
    const lowest = baseline.minimumPopulation[group] - recorded.size;
    if (floor < lowest) {
      throw new Error(`${group} floor ${floor} is below ${lowest}: the ${baseline.minimumPopulation[group]} recorded with the population baseline, less its ${recorded.size} recorded retirement(s).`);
    }
    const gone = [...before].filter((id) => !current.has(id));
    const unrecorded = gone.filter((id) => !recorded.has(id));
    if (unrecorded.length > 0) {
      throw new Error(`${group} lost ${unrecorded.length} case(s) with no retirement record: ${unrecorded.slice(0, 5).join(', ')}${unrecorded.length > 5 ? ', …' : ''}. Record each in scripts/${RETIREMENTS_FILE} with the change that removed its code and the reason, or restore it.`);
    }
    const stillThere = [...recorded].filter((id) => current.has(id));
    if (stillThere.length > 0) throw new Error(`${group} retirement record names case(s) that are still defined: ${stillThere.slice(0, 5).join(', ')}.`);
    const unknown = [...recorded].filter((id) => !before.has(id));
    if (unknown.length > 0) throw new Error(`${group} retirement record names case(s) the baseline never had: ${unknown.slice(0, 5).join(', ')}.`);
    retired[group] = gone.length;
    added[group] = [...current].filter((id) => !before.has(id)).length;
  }
  return { retired, added, baselineRecordedAt: baseline.recordedAt };
}

/** Both checked-in files of this checkout. */
export function loadRetirementInputs(root) {
  const read = (file) => JSON.parse(readFileSync(join(root, 'scripts', file), 'utf8'));
  return { baseline: read(POPULATION_IDS_FILE), retirements: read(RETIREMENTS_FILE) };
}
