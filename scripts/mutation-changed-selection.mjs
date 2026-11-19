// Which mutation cases the changes since a base can affect. This is the `--changed` selector of the developer
// commands: partial by construction, never the gate. A group is `{ label, mutations, definitionsFile, manifest,
// schema }` with repository-relative paths.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { affectedMutationCases, validateProofManifest } from './mutation-focused-runtime.mjs';

function gitOutput(root, args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(run.stderr || String(run.error)).trim()}`);
  return run.stdout;
}

function gitFileAt(root, commit, path) {
  if (!gitOutput(root, ['ls-tree', '--name-only', commit, '--', path]).trim()) return undefined;
  return gitOutput(root, ['show', `${commit}:${path}`]);
}

// The base definitions file is evaluated from a temporary copy, with its relative imports pointed back at the
// scripts it imported, so a case compares by value rather than by how its source text happens to be laid out.
async function basePopulationAt(root, group, commit) {
  const text = gitFileAt(root, commit, group.definitionsFile);
  if (text === undefined) return new Map();
  const scripts = join(root, dirname(group.definitionsFile));
  const rewritten = text.replace(/(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_match, lead, quote, specifier) => `${lead}${quote}${pathToFileURL(join(scripts, specifier)).href}${quote}`);
  const directory = mkdtempSync(join(tmpdir(), 'unode-mutation-base-'));
  try {
    const file = join(directory, 'definitions.mjs');
    writeFileSync(file, rewritten, 'utf8');
    const loaded = await import(pathToFileURL(file).href);
    return new Map(loaded.ALL_MUTATIONS.map((mutation) => [mutation.id, mutation]));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The cases of `group` that the changes since `ref` can affect: `{ cases, complete: false, label, notes }`. It is
 * never complete, also when every case is selected.
 */
export async function changedSelection(root, group, ref) {
  const merge = spawnSync('git', ['merge-base', 'HEAD', ref], { cwd: root, encoding: 'utf8', windowsHide: true });
  const base = merge.status === 0 ? merge.stdout.trim() : undefined;
  if (!base) throw new Error(`--changed cannot find where HEAD and ${ref} diverge.`);
  const since = `changes since ${base.slice(0, 7)} (${ref})`;
  const proofById = validateProofManifest(JSON.parse(readFileSync(join(root, group.manifest), 'utf8')), group.mutations, group.schema);
  // Committed, staged and unstaged changes against the base, plus untracked files, since the sandbox copies the
  // working tree. Renames are split into a deletion and an addition; an untracked directory is reported once,
  // with a trailing slash.
  const changedPaths = [];
  const removedPaths = [];
  const status = gitOutput(root, ['diff', '--name-status', '--no-renames', '-z', base]).split('\0');
  for (let index = 0; index + 1 < status.length; index += 2) {
    (status[index] === 'A' || status[index] === 'M' ? changedPaths : removedPaths).push(status[index + 1]);
  }
  changedPaths.push(...gitOutput(root, ['ls-files', '--others', '--exclude-standard', '--directory', '-z']).split('\0').filter(Boolean));
  const everyCase = (reason) => ({
    cases: group.mutations,
    complete: false,
    label: `all ${group.mutations.length} cases (${reason})`,
    notes: ['Every case was selected, but this is still change-scoped feedback, not the complete gate.'],
  });
  let basePopulation;
  let baseProofById;
  try {
    basePopulation = await basePopulationAt(root, group, base);
    const manifestText = gitFileAt(root, base, group.manifest);
    baseProofById = new Map((manifestText === undefined ? [] : JSON.parse(manifestText).cases ?? [])
      .map((entry) => [entry.id, entry]));
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    return everyCase(`the case definitions at ${base.slice(0, 7)} could not be compared: ${message}`);
  }
  const affected = affectedMutationCases({ mutations: group.mutations, proofById, basePopulation, baseProofById, changedPaths, removedPaths });
  if (affected.full) return everyCase(affected.reason);
  const ids = new Set(affected.ids);
  const notes = ['Not selected: a change that alters how another file\'s mutant is reached, such as a change to a mapped file\'s imports. CI runs the complete population.'];
  if (affected.unmapped.length > 0) notes.push(`Changed src paths that no ${group.label} case names: ${affected.unmapped.join(', ')}`);
  return {
    cases: group.mutations.filter((mutation) => ids.has(mutation.id)),
    complete: false,
    label: `${ids.size} case(s) affected by ${since}`,
    notes,
  };
}
