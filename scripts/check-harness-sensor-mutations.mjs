#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * Mutation gate for the v0.9.36 Harness Lab sensors.
 *
 * Every Requirement.met initializer is replaced with true, one at a time, in a temporary copy.
 * A passing focused suite means that requirement is unconstrained and the mutant survived.
 *
 * The TypeScript AST finds property assignments rather than matching line text. This matters for E2,
 * whose object brace and met property are on different lines and was missed by the first manual sweep.
 * The working tree is never mutated.
 *--------------------------------------------------------------------------------------------*/

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const SOURCE = 'src/harness/sensors.ts';
const SUITE = 'src/harness/__tests__/taskSet.test.ts';
const ROOT = resolve('.');
const SANDBOX_ROOT = process.env.RUNNER_TEMP && process.env.RUNNER_TEMP.trim()
  ? process.env.RUNNER_TEMP.trim()
  : tmpdir();
const SANDBOX = join(SANDBOX_ROOT, 'unodeai-harness-mutation-' + process.pid);

function resolveNodeModules(start) {
  let directory = start;
  for (;;) {
    const candidate = join(directory, 'node_modules');
    if (existsSync(join(candidate, 'vitest')) && existsSync(join(candidate, 'typescript'))) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error('Could not find populated node_modules above ' + start + '.');
    }
    directory = parent;
  }
}

function copyFile(relativePath) {
  const target = join(SANDBOX, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(ROOT, relativePath), target);
}

function prepareSandbox() {
  mkdirSync(join(SANDBOX, 'src'), { recursive: true });
  cpSync(join(ROOT, 'src', 'harness'), join(SANDBOX, 'src', 'harness'), { recursive: true });
  for (const file of ['package.json', 'tsconfig.json', 'vitest.config.ts']) {
    copyFile(file);
  }
  symlinkSync(
    resolveNodeModules(ROOT),
    join(SANDBOX, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
}

function cleanup() {
  try { rmdirSync(join(SANDBOX, 'node_modules')); } catch { /* junction may already be absent */ }
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
}

function requirementInitializers(sourceText) {
  const sourceFile = ts.createSourceFile(SOURCE, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
      requirements.push({
        start: node.initializer.getStart(sourceFile),
        end: node.initializer.end,
        id: idProperty.initializer.text,
        reason: reasonProperty.initializer.text,
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return requirements;
}

function runFocusedSuite() {
  const nodeModules = resolveNodeModules(ROOT);
  const vitest = join(nodeModules, 'vitest', 'vitest.mjs');
  const preserve = '--preserve-symlinks --preserve-symlinks-main';
  const nodeOptions = ((process.env.NODE_OPTIONS || '') + ' ' + preserve).trim();
  return spawnSync(process.execPath, [vitest, 'run', SUITE], {
    cwd: SANDBOX,
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function reportFailure(result) {
  const output = outputOf(result);
  if (output) {
    console.error(output.slice(-6000));
  }
  if (result.error) {
    console.error(result.error);
  }
}

function outputOf(result) {
  return ((result.stdout || '') + '\n' + (result.stderr || '')).trim();
}

function isExpectedAssertionFailure(result, requirement) {
  const output = outputOf(result);
  return result.status === 1
    && !result.error
    && !result.signal
    && output.includes('AssertionError')
    && output.includes("['" + requirement.id + "']");
}

let gatePassed = false;
try {
  prepareSandbox();
  const sourcePath = join(SANDBOX, SOURCE);
  const original = readFileSync(sourcePath, 'utf8');
  const requirements = requirementInitializers(original);
  if (requirements.length === 0) {
    throw new Error('No Requirement.met property assignments found.');
  }
  if (new Set(requirements.map((requirement) => requirement.id)).size !== requirements.length) {
    throw new Error('Requirement ids must be unique.');
  }

  const baseline = runFocusedSuite();
  if (baseline.status !== 0) {
    console.error('Focused suite is not green on unmutated source.');
    reportFailure(baseline);
  } else {
    console.log('baseline green; AST found ' + requirements.length + ' sensor requirements');
    const survivors = [];
    const invalidRuns = [];

    for (const [index, requirement] of requirements.entries()) {
      const mutant = original.slice(0, requirement.start) + 'true' + original.slice(requirement.end);
      writeFileSync(sourcePath, mutant, 'utf8');
      const result = runFocusedSuite();
      const survived = result.status === 0;
      const killed = isExpectedAssertionFailure(result, requirement);
      const number = String(index + 1).padStart(2, '0');
      const label = survived ? 'SURVIVED' : killed ? 'killed  ' : 'INVALID ';
      console.log(label + ' ' + number + '  [' + requirement.id + '] ' + requirement.reason);
      if (survived) {
        survivors.push(requirement);
      } else if (!killed) {
        invalidRuns.push({ requirement, result });
      }
    }
    writeFileSync(sourcePath, original, 'utf8');

    if (survivors.length > 0) {
      console.error('\n' + survivors.length + ' requirement mutant(s) survived:');
      for (const survivor of survivors) {
        console.error('  - [' + survivor.id + '] ' + survivor.reason);
      }
    }
    if (invalidRuns.length > 0) {
      console.error('\n' + invalidRuns.length + ' mutation run(s) failed without the expected named assertion:');
      for (const invalid of invalidRuns) {
        console.error('  - [' + invalid.requirement.id + '] ' + invalid.requirement.reason);
        reportFailure(invalid.result);
      }
    }
    if (survivors.length === 0 && invalidRuns.length === 0) {
      console.log('\nevery sensor requirement mutant killed (' + requirements.length + '/' + requirements.length + ')');
      gatePassed = true;
    }
  }
} catch (error) {
  console.error(error);
} finally {
  cleanup();
}

if (!gatePassed) {
  process.exitCode = 1;
}
