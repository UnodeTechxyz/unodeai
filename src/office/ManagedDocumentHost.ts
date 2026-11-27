import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { terminateChildProcessTree } from '../backend/processTree';
import type { ManagedOutput } from './ManagedOfficeContracts';
import type { ManagedProgram } from './ManagedProgramStore';
import type { DocumentRunnerContext } from './DocumentRunner';

export interface ManagedInput { ref: string; bytes: Buffer; sha256: string; extension: string }
export interface ManagedNativeExecution {
  runnerPath: string; programPath: string; programSha256: string; contextPath: string; contextSha256: string;
  stageRoot: string; cwd: string; signal: AbortSignal;
}
export type ManagedOfficeExecutor = (job: ManagedNativeExecution) => Promise<void>;
export interface ManagedRunJob {
  operationId: string;
  program: ManagedProgram; outputs: ManagedOutput[]; inputs: ManagedInput[]; assets: ManagedInput[];
  cwd: string; environment: NodeJS.ProcessEnv; signal: AbortSignal;
  beforeStart(command: string, readPaths: string[], recheckProgram: () => Promise<void>): Promise<void>;
  memoryBudget: number;
  execute?: ManagedOfficeExecutor;
}
export interface ManagedGenerated { declaration: ManagedOutput; bytes: Buffer; sha256: string }
export interface ManagedRunResult { operation_id: string; runner_sha256: string; command_status: 'exited'; cleanup: 'removed' | 'not-removed'; dependency_versions: { docx: '9.7.1'; docx_patch: 'embedded-nanoid-5.1.16-fix'; pptxgenjs: '4.0.1' }; outputs: ManagedGenerated[] }

/** Owns subprocess/staging. The native execution port preserves its provider's selected OS sandbox. */
export class ManagedDocumentHost {
  constructor(readonly runner = join(__dirname, 'office', 'DocumentRunner.js'),
    private readonly launch: typeof fork = fork,
    private readonly terminate: (child: ChildProcess) => ReturnType<typeof terminateChildProcessTree> = terminateChildProcessTree,
    private readonly removeStage: (directory: string) => Promise<void> = directory => rm(directory, { recursive: true, force: true })) {}

  async run(job: ManagedRunJob): Promise<ManagedRunResult> {
    const stage = await realpath(await mkdtemp(join(tmpdir(), 'unode-office-build-')));
    let result: ManagedRunResult | undefined;
    let failure: unknown;
    try {
      await mkdir(join(stage, 'outputs'));
      const outputRoot = await realpath(join(stage, 'outputs'));
      const context: DocumentRunnerContext = { outputs: {}, inputs: {}, assets: {} };
      for (const item of job.outputs) context.outputs[item.name] = join(outputRoot, item.name + '.' + item.format);
      for (const [kind, items] of [['inputs', job.inputs], ['assets', job.assets]] as const) {
        const folder = join(stage, kind); await mkdir(folder);
        for (const item of items) {
          if (!/^[a-zA-Z0-9-]+$/.test(item.ref) || !/^\.[a-zA-Z0-9]+$/.test(item.extension)
            || createHash('sha256').update(item.bytes).digest('hex') !== item.sha256) throw Error('managed-input-changed');
          const target = join(folder, item.ref + item.extension);
          await writeFile(target, item.bytes, { flag: 'wx', mode: 0o600 }); context[kind][item.ref] = target;
        }
      }
      const checkProgram = async () => {
        if (job.signal.aborted) throw Error('managed-build-stopped');
        const stat = await lstat(job.program.file);
        if (!stat.isFile() || stat.isSymbolicLink() || await realpath(job.program.file) !== job.program.file) throw Error('managed-program-changed');
        const bytes = await readFile(job.program.file);
        if (bytes.length !== job.program.bytes || createHash('sha256').update(bytes).digest('hex') !== job.program.sha256) throw Error('managed-program-changed');
      };
      const runnerPath = await realpath(resolve(this.runner));
      const runnerHash = createHash('sha256').update(await readFile(runnerPath)).digest('hex');
      const checkIdentity = async () => {
        await checkProgram();
        const stat = await lstat(runnerPath);
        if (!stat.isFile() || stat.isSymbolicLink() || await realpath(runnerPath) !== runnerPath
          || createHash('sha256').update(await readFile(runnerPath)).digest('hex') !== runnerHash) throw Error('managed-runner-changed');
      };
      // The gate sees the ordinary command identity. Spawn uses argv/IPC, never shell evaluation.
      const contextPath = join(stage, 'context.json'); const contextBytes = Buffer.from(JSON.stringify(context));
      const contextSha256 = createHash('sha256').update(contextBytes).digest('hex');
      if (job.execute) await writeFile(contextPath, contextBytes, { flag: 'wx', mode: 0o600 });
      const command = `node "${runnerPath}" "${job.program.file}"`
        + (job.execute ? ` ${job.program.sha256} --context "${contextPath}" ${contextSha256}` : '');
      await job.beforeStart(command, [runnerPath, job.program.file, ...(job.execute ? [contextPath] : []), ...Object.values(context.inputs), ...Object.values(context.assets)], checkIdentity);
      await checkIdentity();
      if (job.execute) await job.execute({ runnerPath, programPath: job.program.file, programSha256: job.program.sha256,
        contextPath, contextSha256, stageRoot: stage, cwd: job.cwd, signal: job.signal });
      else await this.execute(job, context, runnerPath);
      if (job.signal.aborted) throw Error('managed-build-stopped');
      const entries = await readdir(outputRoot, { withFileTypes: true });
      const expected = new Set(job.outputs.map(output => output.name + '.' + output.format));
      if (entries.length !== expected.size || entries.some(entry => !entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name))) throw Error('managed-output-declarations-mismatch');
      const outputs: ManagedGenerated[] = [];
      let available = job.memoryBudget;
      for (const declaration of job.outputs) {
        const file = context.outputs[declaration.name]; const stat = await lstat(file);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > available
          || await realpath(file) !== file || await realpath(outputRoot) !== outputRoot) throw Error('managed-output-unavailable');
        const handle = await open(file, 'r'); let bytes: Buffer;
        try {
          const before = await handle.stat();
          if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size) throw Error('managed-output-changed');
          bytes = Buffer.allocUnsafe(before.size);
          for (let offset = 0; offset < bytes.length;) {
            const chunk = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
            if (!chunk.bytesRead) throw Error('managed-output-changed'); offset += chunk.bytesRead;
          }
          const after = await handle.stat(); const named = await lstat(file);
          if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
            || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino || await realpath(file) !== file) throw Error('managed-output-changed');
        } finally { await handle.close(); }
        available -= bytes.length;
        outputs.push({ declaration, bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      result = { operation_id: job.operationId, runner_sha256: runnerHash, command_status: 'exited', cleanup: 'removed', dependency_versions: { docx: '9.7.1', docx_patch: 'embedded-nanoid-5.1.16-fix', pptxgenjs: '4.0.1' }, outputs };
      return result;
    } catch (error) {
      failure = error; throw error;
    } finally {
      // This exact fresh directory is host-created; no deletion of a user-supplied path.
      let removed = false;
      try {
        const stat = await lstat(stage).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
        if (!stat) removed = true;
        else if (stat.isDirectory() && !stat.isSymbolicLink() && await realpath(stage) === stage) {
          await this.removeStage(stage); removed = true;
        }
      } catch { /* Cleanup cannot replace the actual capture/Stop outcome. No other path is deleted. */ }
      if (!removed) {
        if (result) result.cleanup = 'not-removed';
        if (failure && typeof failure === 'object') Object.assign(failure, { managedCleanupIncomplete: true });
      }
    }
  }

  private execute(job: ManagedRunJob, context: DocumentRunnerContext, runnerPath: string): Promise<void> {
    return new Promise((resolveRun, reject) => {
      if (job.signal.aborted) { reject(Error('managed-build-stopped')); return; }
      let child: ChildProcess;
      let settled = false;
      let stopping: string | undefined;
      let programFailure = 'managed-program-failed';
      const finish = (error?: string) => {
        if (settled) return; settled = true; job.signal.removeEventListener('abort', stop);
        if (error) reject(Error(error)); else resolveRun();
      };
      const stopWith = (reason: string) => {
        if (stopping || settled) return; stopping = reason;
        void this.terminate(child).then(result => finish(result.status === 'confirmed-stopped' || result.status === 'already-stopped' ? reason : 'managed-build-stop-unconfirmed'), () => finish('managed-build-stop-unconfirmed'));
      };
      const stop = () => stopWith('managed-build-stopped');
      try {
        const options = {
          cwd: job.cwd, env: { ...job.environment, ELECTRON_RUN_AS_NODE: '1' }, execArgv: [],
          windowsHide: true, silent: true,
        };
        child = this.launch(runnerPath, [job.program.file, job.program.sha256], options);
        // Drain without retaining arbitrary program output. It is never a receipt or verification fact.
        child.stdout?.resume(); child.stderr?.resume();
        child.once('error', () => finish('managed-build-launch-failed'));
        child.on('message', message => {
          if (message && typeof message === 'object' && 'type' in message && message.type === 'unode-office-runner-error'
            && 'kind' in message && ['syntax', 'type', 'runtime'].includes(String(message.kind))) programFailure = 'managed-program-' + message.kind;
        });
        child.once('close', code => { if (!stopping) finish(code === 0 ? undefined : programFailure); });
        job.signal.addEventListener('abort', stop, { once: true });
        if (job.signal.aborted) stop(); else child.send(context, error => { if (error) stopWith('managed-build-launch-failed'); });
      } catch { finish('managed-build-launch-failed'); }
    });
  }
}
