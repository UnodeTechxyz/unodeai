#!/usr/bin/env node
import { spawn } from 'node:child_process';

const workerArg = process.argv.find((arg) => arg.startsWith('--workers='));
const workers = workerArg ? Number(workerArg.slice('--workers='.length)) : 4;
if (!Number.isSafeInteger(workers) || workers < 1 || workers > 8) {
  throw new Error('--workers must be an integer from 1 to 8.');
}
const unexpected = process.argv.slice(2).filter((arg) => arg !== workerArg);
if (unexpected.length > 0) throw new Error(`Unknown option(s): ${unexpected.join(', ')}`);
const gateStarted = Date.now();

const tasks = [
  ['runner contract', 'scripts/mutation-runtime.selftest.mjs'],
  ['focused runner contract', 'scripts/mutation-focused-runtime.selftest.mjs'],
  ['focused main', 'scripts/mutation-focused-main.mjs'],
  ['focused v0.9.73', 'scripts/mutation-focused-main.mjs', '--group=v0973'],
  ['harness sensors', 'scripts/check-harness-sensor-mutations.mjs'],
  ['shared memory', 'scripts/check-shared-memory-trust-mutations.mjs'],
];

function run([label, script, ...args]) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({
      label,
      code: 1,
      stdout,
      stderr: `${stderr}\n${error.stack ?? error}`,
      ms: Date.now() - started,
    }));
    child.on('close', (code) => resolve({ label, code: code ?? 1, stdout, stderr, ms: Date.now() - started }));
  });
}

let next = 0;
const results = [];
async function consume() {
  while (next < tasks.length) {
    const task = tasks[next++];
    console.log(`START ${task[0]}`);
    const result = await run(task);
    results.push(result);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    console.log(`${result.code === 0 ? 'PASS' : 'FAIL'} ${result.label} (${(result.ms / 1000).toFixed(1)}s)`);
  }
}

console.log(`Running the complete mutation population as ${tasks.length} isolated tasks with ${workers} workers.`);
await Promise.all(Array.from({ length: Math.min(workers, tasks.length) }, consume));
const failures = results.filter((result) => result.code !== 0);
function sumReported(prefix, pattern) {
  return results
    .filter((result) => result.label.startsWith(prefix))
    .reduce((sum, result) => {
      const match = pattern.exec(result.stdout);
      return sum + (match ? Number(match[1]) : 0);
    }, 0);
}
const observedPopulation = {
  main: sumReported('focused main', /Focused main mutation population passed \((\d+)\/\d+;/),
  v0973: sumReported('focused v0.9.73', /Focused v0\.9\.73 mutation population passed \((\d+)\/\d+;/),
  sensors: sumReported('harness sensors', /every sensor requirement mutant killed \((\d+)\/\d+\)/),
  sharedMemory: results.some((result) => result.label === 'shared memory' && result.stdout.includes('killed:')) ? 1 : 0,
};
const minimumPopulation = { main: 52, v0973: 41, sensors: 43, sharedMemory: 1 };
for (const [group, minimum] of Object.entries(minimumPopulation)) {
  if (observedPopulation[group] < minimum) {
    failures.push({ label: `${group} population ${observedPopulation[group]}/${minimum}` });
  }
}
console.log(`Population observed: main ${observedPopulation.main}, v0.9.73 ${observedPopulation.v0973}, sensors ${observedPopulation.sensors}, shared memory ${observedPopulation.sharedMemory}.`);
if (failures.length > 0) {
  console.error(`Mutation gate failed in ${failures.length} task(s): ${failures.map((result) => result.label).join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`Complete mutation population passed (${tasks.length}/${tasks.length} tasks; ${((Date.now() - gateStarted) / 1000).toFixed(1)}s).`);
}
