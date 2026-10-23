// Mutation engine v2: warm workers. One coordinator process hands proof-file units to local workers. Each worker is
// a separate process (mutation-warm-worker.mjs) with its own sandbox and one Vitest controller that stays up across
// cases. The verdict for a case comes from the same classifyVitestProof the cold focused runner uses.
//
// What a warm engine adds to the proof is the cache: a mutant left in a controller makes the next proof fail for
// the wrong reason, and that is reported as a kill. So every case ends with a check that no transform of the
// mutated file is still cached, and any fault in that check, or any failure between writing a mutant and restoring
// it, ends the worker's epoch: the controller is discarded and a new one starts.
import { fork, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMutationCopyFilter, replaceExactlyOnce } from './mutation-runtime.mjs';
import { classifyVitestProof, escapeTestName } from './mutation-focused-runtime.mjs';

export const WARM_ENGINE = 'warm-vitest-v2';
export const CASE_TIMEOUT_MS = 60_000;
export const BASELINE_TIMEOUT_MS = 180_000;
// A controller keeps every module it has run. Its memory grows with the cases it judges, so an epoch ends after
// this many and a new controller starts. The number is fixed here; a run never relaxes it.
export const EPOCH_CASE_LIMIT = 150;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function resolveNodeModules(root) {
  for (let directory = root; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules');
    try {
      readFileSync(join(candidate, 'vitest', 'package.json'));
      return candidate;
    } catch { /* keep looking */ }
    if (dirname(directory) === directory) throw new Error(`could not find Vitest above ${root}`);
  }
}

// A copy of the working tree with node_modules as a junction, as the cold runner builds it. `files` are written
// into the copy only: planted fixtures never exist in the repository.
export function createSandbox(root, label, files = {}) {
  const sandbox = mkdtempSync(join(process.env.RUNNER_TEMP?.trim() || tmpdir(), `unode-warm-${label}-`));
  cpSync(root, sandbox, { recursive: true, filter: createMutationCopyFilter(root) });
  symlinkSync(resolveNodeModules(root), join(sandbox, 'node_modules'), 'junction');
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(sandbox, dirname(file)), { recursive: true });
    writeFileSync(join(sandbox, file), text, 'utf8');
  }
  return sandbox;
}

export function removeSandbox(sandbox) {
  // The junction first: removing the tree through it would delete the real node_modules.
  try { rmdirSync(join(sandbox, 'node_modules')); } catch { /* already absent */ }
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* a temporary directory only */ }
}

export const sandboxEnv = (sandbox) => ({
  ...process.env,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --preserve-symlinks --preserve-symlinks-main`.trim(),
  // A Vitest that starts in the sandbox from the checked-in configuration keeps its Vite cache there too. Left to
  // the default it lands, through the junction, in the real node_modules as a directory that nothing removes.
  UNODE_VITEST_CACHE_DIR: join(sandbox, '.vite-cache'),
});

// Stop a process together with the test process it forked. On Windows a forked child ends with its parent anyway.
// On POSIX it does not, and a hung mutant would spin on, so the group is killed there.
export function killTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

const exited = (child) => new Promise((done) => {
  if (child.exitCode !== null || child.signalCode !== null) done();
  else child.once('exit', () => done());
});

class WorkerFault extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

class WarmWorker {
  constructor(index, sandbox) {
    this.index = index;
    this.sandbox = sandbox;
    this.epoch = 0;
    this.seq = 0;
    this.casesInEpoch = 0;
    this.canaried = new Set();
    this.restarts = [];
    this.rotations = 0;
    this.memory = [];
    this.stderr = '';
  }

  async start() {
    this.epoch += 1;
    this.casesInEpoch = 0;
    this.canaried = new Set();
    this.child = fork(join(this.sandbox, 'scripts', 'mutation-warm-worker.mjs'), [], {
      cwd: this.sandbox,
      env: sandboxEnv(this.sandbox),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    this.child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-4000); });
    try {
      this.info = await this.request({ type: 'init' }, CASE_TIMEOUT_MS);
    } catch (error) {
      killTree(this.child);
      throw new Error(`warm worker ${this.index} did not start: ${error.message}\n${this.stderr}`);
    }
    if (this.info.cacheDir.startsWith('..') || this.info.cacheDir.startsWith('node_modules')) {
      killTree(this.child);
      throw new Error(`warm worker ${this.index} keeps its Vite cache outside its sandbox: ${this.info.cacheDir}`);
    }
  }

  request(message, timeoutMs) {
    const seq = ++this.seq;
    const child = this.child;
    return new Promise((done, fail) => {
      const settle = (error, value) => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
        if (error) fail(error);
        else done(value);
      };
      const onMessage = (reply) => {
        if (reply.seq !== seq) return;
        if (reply.ok) settle(undefined, reply.value);
        else settle(new WorkerFault('error', reply.error));
      };
      const onExit = (code, signal) => settle(new WorkerFault('exit', `worker process exited (${code ?? signal})`));
      const timer = setTimeout(() => settle(new WorkerFault('timeout', `no reply within ${timeoutMs}ms`)), timeoutMs);
      child.on('message', onMessage);
      child.on('exit', onExit);
      try {
        child.send({ ...message, seq });
      } catch (error) {
        settle(new WorkerFault('exit', `worker channel is closed (${error.message})`));
      }
    });
  }

  // An unplanned end of the epoch: kill the controller and its test process, put the original bytes back, start a
  // new controller.
  async restart(reason, restore) {
    killTree(this.child);
    await exited(this.child);
    if (restore) writeFileSync(join(this.sandbox, restore.file), restore.text, 'utf8');
    this.restarts.push({ epoch: this.epoch, reason });
    await this.start();
  }

  // The planned end of an epoch, and the end of the run.
  async stop() {
    try {
      this.memory.push(await this.request({ type: 'close' }, CASE_TIMEOUT_MS));
      // The timer is cleared: left pending, it keeps the coordinator process alive for its full ten seconds.
      let timer;
      await Promise.race([exited(this.child), new Promise((done) => { timer = setTimeout(done, 10_000); })]);
      clearTimeout(timer);
    } catch (error) {
      if (!(error instanceof WorkerFault)) throw error;
    } finally {
      killTree(this.child);
    }
  }

  async rotate() {
    await this.stop();
    this.rotations += 1;
    await this.start();
  }
}

function proofTest(run, testFile, testName) {
  return run.tests.filter((test) => test.file === testFile && test.name === testName);
}

// The cold runner's baseline rule, for one proof file: the whole file is green, and every declared proof is
// exactly one passing test.
export function baselineProblems(run, unit) {
  const problems = [];
  if (run.exitCode !== 0 || run.collectionErrors.length > 0 || run.modules !== 1) {
    problems.push(`${unit.testFile} did not complete green`);
  }
  for (const [id, name] of unit.items.map((item) => [item.id, item.baselineName ?? item.testName])) {
    const passing = proofTest(run, unit.testFile, name).filter((test) => test.status === 'passed');
    if (passing.length !== 1) problems.push(`${id} baseline proof matched ${passing.length} passing tests`);
  }
  return problems;
}

async function judgeCase(worker, item, original) {
  const applied = replaceExactlyOnce(original, item.mutation);
  const started = Date.now();
  const result = { id: item.id, worker: worker.index, epoch: worker.epoch };
  if (applied.kind === 'invalid') return { ...result, verdict: 'invalid', reason: applied.reason, durationMs: 0 };
  const endEpoch = async (verdictReason, kind) => {
    await worker.restart(`${item.id}: ${kind}`, { file: item.file, text: original });
    return { ...result, verdict: 'invalid', reason: verdictReason, durationMs: Date.now() - started, epochEnded: kind };
  };
  let reply;
  try {
    reply = await worker.request({
      type: 'case', file: item.file, mutantText: applied.text, originalSha256: sha256(original),
      testFile: item.testFile, testName: escapeTestName(item.testName), defect: item.defect,
    }, item.timeoutMs ?? CASE_TIMEOUT_MS);
  } catch (fault) {
    if (!(fault instanceof WorkerFault)) throw fault;
    // The mutant may still be on disk and in the cache. The case is invalid, never a kill.
    return endEpoch(fault.kind === 'timeout' ? 'runner crashed, could not launch, or timed out'
      : `warm worker ${fault.kind}: ${fault.message.split('\n')[0].slice(0, 200)}`, fault.kind);
  }
  worker.casesInEpoch += 1;
  const outcome = classifyVitestProof(reply.run, { testFile: item.testFile, testName: item.testName });
  const cache = [];
  if (!reply.restoredBytes) cache.push('the restored bytes differ from the original');
  if (reply.staleBeforeRun.length > 0) cache.push(`a transform was still cached when the mutant ran (${reply.staleBeforeRun.length})`);
  if (reply.staleAfterRestore.length > 0) cache.push(`a transform survived the restore (${reply.staleAfterRestore.length})`);
  if (cache.length > 0) {
    // A cache fault outranks whatever the proof said: nothing this controller judges afterwards can be trusted.
    const faulted = { proofVerdict: outcome.verdict };
    if (item.defect === 'skip-restore-invalidation') {
      // A drill records what the fault would have done to the next case.
      const name = item.canaryName ?? item.testName;
      const leaked = await worker.request({ type: 'proof', testFile: item.testFile, testName: escapeTestName(name) }, CASE_TIMEOUT_MS);
      faulted.nextProofOnRestoredBytes = classifyVitestProof(leaked, { testFile: item.testFile, testName: name }).verdict;
    }
    return { ...await endEpoch(cache.join('; '), 'cache-fault'), ...faulted };
  }
  Object.assign(result, { verdict: outcome.verdict, reason: outcome.reason, durationMs: reply.run.durationMs });
  // After the first mutant of a source in this epoch, its proof must pass again on the restored bytes.
  if (!worker.canaried.has(item.file)) {
    worker.canaried.add(item.file);
    const name = item.canaryName ?? item.testName;
    let canary;
    try {
      canary = await worker.request({ type: 'proof', testFile: item.testFile, testName: escapeTestName(name) }, CASE_TIMEOUT_MS);
    } catch (fault) {
      if (!(fault instanceof WorkerFault)) throw fault;
      return { ...await endEpoch(`restore canary: warm worker ${fault.kind}`, 'canary-fault'), proofVerdict: outcome.verdict };
    }
    result.canaryMs = canary.durationMs;
    if (canary.exitCode !== 0 || proofTest(canary, item.testFile, name).filter((test) => test.status === 'passed').length !== 1) {
      return { ...await endEpoch('the proof did not pass again on the restored bytes', 'canary-failed'), proofVerdict: outcome.verdict, canary: 'failed' };
    }
    result.canary = 'passed';
  }
  return result;
}

async function runBaseline(worker, unit, phase) {
  try {
    const run = await worker.request({ type: 'baseline', testFile: unit.testFile }, BASELINE_TIMEOUT_MS);
    return { worker: worker.index, epoch: worker.epoch, testFile: unit.testFile, phase, durationMs: run.durationMs, tests: run.tests.length, problems: baselineProblems(run, unit) };
  } catch (fault) {
    if (!(fault instanceof WorkerFault)) throw fault;
    await worker.restart(`${unit.testFile} baseline: ${fault.kind}`);
    return { worker: worker.index, epoch: worker.epoch, testFile: unit.testFile, phase, durationMs: 0, tests: 0, problems: [`${unit.testFile} baseline: warm worker ${fault.kind}`] };
  }
}

/** Group cases by proof file: the unit a worker takes, so each baseline runs once, where its cases are judged. */
export function proofFileUnits(items) {
  const units = new Map();
  for (const item of items) {
    const unit = units.get(item.testFile) ?? { testFile: item.testFile, items: [] };
    unit.items.push(item);
    units.set(item.testFile, unit);
  }
  // The largest units first, so the last worker to finish is not holding the biggest one.
  return [...units.values()].sort((left, right) => right.items.length - left.items.length
    || (left.testFile < right.testFile ? -1 : left.testFile > right.testFile ? 1 : 0));
}

/**
 * Judge every item. `originals` maps a source file to the bytes its mutants are made from. A unit whose opening
 * baseline is not green is not judged: its cases are reported invalid, as the cold runner refuses to start.
 */
export async function runWarmEngine({
  root, items, originals, workerCount, files = {}, epochCaseLimit = EPOCH_CASE_LIMIT, closingBaseline = false,
  log = () => {},
}) {
  const started = Date.now();
  const queue = proofFileUnits(items);
  const workers = [];
  const sandboxes = [];
  const results = new Map();
  const baselines = [];
  // Wall time of each stage, so a slow run says where it was slow.
  const phases = { sandboxMs: 0, startMs: 0, judgeMs: 0, stopMs: 0 };
  const phase = (name, since) => { phases[name] = Date.now() - since; return Date.now(); };
  try {
    for (let index = 0; index < Math.min(workerCount, Math.max(queue.length, 1)); index++) {
      sandboxes.push(createSandbox(root, `w${index}`, files));
      workers.push(new WarmWorker(index, sandboxes[index]));
    }
    let mark = phase('sandboxMs', started);
    await Promise.all(workers.map((worker) => worker.start()));
    mark = phase('startMs', mark);
    const judged = workers.map(() => []);
    await Promise.all(workers.map(async (worker) => {
      for (let unit = queue.shift(); unit; unit = queue.shift()) {
        const opening = await runBaseline(worker, unit, 'opening');
        baselines.push(opening);
        judged[worker.index].push(unit);
        for (const item of unit.items) {
          if (opening.problems.length > 0) {
            results.set(item.id, { id: item.id, worker: worker.index, epoch: worker.epoch, verdict: 'invalid', reason: 'the proof file baseline was not green', durationMs: 0 });
            continue;
          }
          if (worker.casesInEpoch >= epochCaseLimit) await worker.rotate();
          const result = await judgeCase(worker, item, originals.get(item.file));
          results.set(item.id, result);
          log(`${result.verdict.toUpperCase().padEnd(8)} ${item.id} ${(result.durationMs / 1000).toFixed(1)}s w${worker.index} e${result.epoch}${result.reason ? ` — ${result.reason}` : ''}${result.epochEnded ? ` [epoch ended: ${result.epochEnded}]` : ''}`);
        }
      }
      if (closingBaseline) {
        for (const unit of judged[worker.index]) baselines.push(await runBaseline(worker, unit, 'closing'));
      }
    }));
    mark = phase('judgeMs', mark);
    await Promise.all(workers.map((worker) => worker.stop()));
    phase('stopMs', mark);
  } finally {
    for (const worker of workers) killTree(worker.child);
    for (const sandbox of sandboxes) removeSandbox(sandbox);
  }
  return {
    results,
    baselines,
    phases,
    wallMs: Date.now() - started,
    workers: workers.map((worker) => ({
      index: worker.index, epochs: worker.epoch, rotations: worker.rotations, restarts: worker.restarts,
      memory: worker.memory, vitest: worker.info?.vitest, pool: worker.info?.pool, isolate: worker.info?.isolate,
    })),
  };
}
