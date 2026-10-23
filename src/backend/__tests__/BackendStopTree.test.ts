import { spawn as realSpawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { ClaudeHeadlessBackend } from '../ClaudeHeadlessBackend';
import { CodexBackend } from '../CodexBackend';
import { OpenAICompatBackend } from '../OpenAICompatBackend';
import { createLocalMcpServer } from '../../mcp/LocalMcpServer';
import type { ProcessTerminationOutcome } from '../processTree';
import type { AgentConfig } from '../../types';
import { fixedCodexProgram } from './codexProgramFixture';

/*
 * v0.9.97 L0: a backend's stop reports what it observed of the process tree it started, and a launcher that exited is
 * not that tree. Field incident (2026-10-19): a Claude CLI started through the npm `.cmd` shim still called
 * publish_task_artifact 26 s after Stop. The stop had ended its input, signalled the shell and dropped the tree kill
 * when the shell exited.
 *
 * DESIGN_v0997 review resolution, section 6: "不能因 wrapper 的 exit 就推断所有后代已停 ... 关本地工具服务不等于停止 CLI".
 * The real-process tests start only this test's own harmless node processes; they are kept apart from the injected
 * ones below.
 */

/** The stand-in for the CLI: a harmless idle node process that records its own number. */
const CLI = `
require('fs').writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`;

/**
 * A root process that starts the stand-in CLI and ends when its own input ends, leaving that child running. The child
 * is detached so that on Windows it is outside the job object Node gives its children; a native launcher such as
 * Codex App Server, or `cmd.exe`, does not end its children when it ends.
 */
const ROOT = `
const { spawn } = require('child_process');
const [cli, pidFile] = process.argv.slice(2);
spawn(process.execPath, [cli, pidFile], { stdio: 'ignore', detached: true }).unref();
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1000);
`;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

/**
 * `shell-launcher` is the field route: on Windows the npm `.cmd` shim run by `cmd.exe` through the shell, as the Claude
 * backend starts it; on POSIX a `sh -c` that stays the stand-in's parent. `node-root` is ROOT above.
 */
async function launcherFixture(kind: 'shell-launcher' | 'node-root') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-l0-stop-'));
  const cli = path.join(dir, 'cli.js');
  const root = path.join(dir, 'root.js');
  const shim = path.join(dir, 'claude-shim.cmd');
  const pidFile = path.join(dir, 'cli.pid');
  await fs.writeFile(cli, CLI);
  await fs.writeFile(root, ROOT);
  await fs.writeFile(shim, `@"${process.execPath}" "${cli}" %*\r\n`);
  const launched: ChildProcess[] = [];
  const spawnLauncher = () => {
    const stdio: ['pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe'];
    const child = kind === 'node-root'
      ? realSpawn(process.execPath, [root, cli, pidFile], { stdio })
      : process.platform === 'win32'
        ? realSpawn(`"${shim}"`, [`"${pidFile}"`], { stdio, shell: true })
        : realSpawn('/bin/sh', ['-c', `"${process.execPath}" "${cli}" "${pidFile}"; exit $?`], { stdio });
    launched.push(child);
    return child;
  };
  const cliPid = async (): Promise<number> => {
    expect(await until(() => { try { return Number(readFileSync(pidFile, 'utf8')) > 0; } catch { return false; } }, 10_000)).toBe(true);
    return Number(await fs.readFile(pidFile, 'utf8'));
  };
  const cleanup = async (pid?: number) => {
    if (pid && alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    for (const child of launched) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await fs.rm(dir, { recursive: true, force: true });
  };
  return { spawnLauncher, cliPid, cleanup };
}

function claudeConfig(): AgentConfig {
  return {
    id: 'writer', name: 'Content Strategist', role: 'custom', skill: '',
    provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'claude-sonnet-4-5', systemPrompt: 'Write.', autoApprove: true, allowedTools: [], backend: 'claude',
    workingDirectory: process.cwd(),
  };
}

function codexConfig(): AgentConfig {
  return {
    id: 'codex-1', name: 'Codex Reviewer', role: 'reviewer', skill: '',
    provider: { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' }, model: 'gpt-5-codex',
    systemPrompt: 'Review.', autoApprove: true, allowedTools: ['read'], backend: 'codex', workingDirectory: process.cwd(),
  };
}

describe('a backend stop and the real process tree it started (real processes)', () => {
  it('Claude: stops the process a launcher started, not just the launcher, and reports it stopped only then', async () => {
    const fixture = await launcherFixture('shell-launcher');
    let pid: number | undefined;
    try {
      const backend = new ClaudeHeadlessBackend(claudeConfig(), undefined, undefined, {
        spawn: (() => fixture.spawnLauncher()) as any,
        // The field route: the npm launcher, started through a shell.
        resolveClaudeLaunch: async () => ({ executable: 'claude-launcher', shell: true }),
      });
      await backend.start({} as NodeJS.ProcessEnv, { pin: 'take' });
      pid = await fixture.cliPid();
      expect(alive(pid)).toBe(true);

      const outcome = await backend.stop(2_000);

      expect(await until(() => !alive(pid!), 5_000)).toBe(true);
      expect(outcome).toEqual({ stopped: true });
    } finally {
      await fixture.cleanup(pid);
    }
  }, 60_000);

  it('Codex: stops App Server\'s tree while its root still runs, though the root ends when its input ends', async () => {
    const fixture = await launcherFixture('node-root');
    let pid: number | undefined;
    try {
      const backend = new CodexBackend(codexConfig(), undefined, {
        launchProgram: fixedCodexProgram('codex'),
        access: () => ({ trusted: true, restricted: false, readRoots: [process.cwd()], writeRoots: [] }),
      });
      (backend as any).proc = fixture.spawnLauncher();
      (backend as any).started = true;
      pid = await fixture.cliPid();

      const outcome = await backend.stop();

      expect(await until(() => !alive(pid!), 5_000)).toBe(true);
      expect(outcome).toEqual({ stopped: true });
    } finally {
      await fixture.cleanup(pid);
    }
  }, 60_000);
});

/** What a stop reports when the process it would have stopped had already ended: what that process started is unseen. */
const CODEX_ENDED = 'App Server had already ended before the stop, so the processes it started could not be observed';
const CLAUDE_ENDED = 'the CLI had already ended before the stop, so the processes it started could not be observed';

/**
 * Codex's audit of the first L0 stop commit: a root that ended by itself before the stop was reported as a stopped
 * tree while a detached child it had started still ran. Once Node has seen a root end, its number may be another
 * process's, so nothing is listed or signalled under it (0.9.96), and what it started is out of reach. AgentBackend's
 * contract: "`stopped` is true only when the whole tree the backend started was seen to stop, or it ran none". The
 * child's liveness, read just before and after the stop, is the oracle: while it runs, `stopped: true` would be false.
 * The root here ends on the end of its input, as App Server can.
 */
describe('a backend stop after its root ended by itself, leaving a detached child (real processes)', () => {
  /** End the root through its input and wait until both Node and the backend have seen it end. */
  async function endRoot(root: ChildProcess, backend?: { pid: number | undefined }): Promise<void> {
    root.stdin!.end();
    expect(await until(() => root.exitCode !== null && (!backend || backend.pid === undefined), 10_000)).toBe(true);
  }

  it('Codex: App Server that ended by itself is not reported stopped, and its child is left as it was', async () => {
    const fixture = await launcherFixture('node-root');
    let pid: number | undefined;
    try {
      let root: ChildProcess | undefined;
      const backend = new CodexBackend(codexConfig(), undefined, {
        launchProgram: fixedCodexProgram('codex'),
        access: () => ({ trusted: true, restricted: false, readRoots: [process.cwd()], writeRoots: [] }),
        spawn: (() => { root = fixture.spawnLauncher(); return root; }) as any,
      });
      // The production spawn path, so the backend's own exit handling sees the root end and lets go of it.
      (backend as any).spawnAppServer();
      (backend as any).started = true;
      pid = await fixture.cliPid();
      await endRoot(root!, backend);
      expect(alive(pid)).toBe(true);

      const outcome = await backend.stop();

      expect(outcome).toEqual({ stopped: false, detail: CODEX_ENDED });
      expect(alive(pid)).toBe(true);
    } finally {
      await fixture.cleanup(pid);
    }
  }, 60_000);

  it('Codex: the same when the stop still finds the ended root (the audit\'s reproduction)', async () => {
    const fixture = await launcherFixture('node-root');
    let pid: number | undefined;
    try {
      const root = fixture.spawnLauncher();
      pid = await fixture.cliPid();
      await endRoot(root);
      expect(alive(pid)).toBe(true);
      const backend = new CodexBackend(codexConfig(), undefined, {
        launchProgram: fixedCodexProgram('codex'),
        access: () => ({ trusted: true, restricted: false, readRoots: [process.cwd()], writeRoots: [] }),
      });
      (backend as any).proc = root;
      (backend as any).started = true;

      const outcome = await backend.stop();

      expect(outcome).toEqual({ stopped: false, detail: CODEX_ENDED });
      expect(alive(pid)).toBe(true);
    } finally {
      await fixture.cleanup(pid);
    }
  }, 60_000);

  it('Claude started directly, without a launcher: a CLI that ended by itself is not reported stopped', async () => {
    const fixture = await launcherFixture('node-root');
    let pid: number | undefined;
    try {
      let root: ChildProcess | undefined;
      const backend = new ClaudeHeadlessBackend(claudeConfig(), undefined, undefined, {
        spawn: (() => { root = fixture.spawnLauncher(); return root; }) as any,
        // A native CLI, started without a shell: no launcher, but it can start processes of its own.
        resolveClaudeLaunch: async () => ({ executable: 'claude', shell: false }),
      });
      await backend.start({} as NodeJS.ProcessEnv, { pin: 'take' });
      pid = await fixture.cliPid();
      await endRoot(root!, backend);
      expect(alive(pid)).toBe(true);

      const outcome = await backend.stop(2_000);

      expect(outcome).toEqual({ stopped: false, detail: CLAUDE_ENDED });
      expect(alive(pid)).toBe(true);
    } finally {
      await fixture.cleanup(pid);
    }
  }, 60_000);
});

/**
 * A process object that is not Node's own child: the backends may only signal it. Its number belongs to no process on
 * any platform (Windows numbers are multiples of 4; POSIX ones stay far below it), so even a backend that wrongly
 * signalled it by number could reach nothing.
 */
function fakeProc() {
  const proc = new EventEmitter() as any;
  proc.pid = 2_147_483_647;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdout.setEncoding = () => undefined;
  proc.stderr.setEncoding = () => undefined;
  proc.stdin = { write: () => true, end: () => undefined };
  proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); return true; };
  setTimeout(() => proc.emit('spawn'), 0);
  return proc;
}

describe('what a backend stop reports (injected)', () => {
  it('Claude: closes every local endpoint before the tree stop starts', async () => {
    const order: string[] = [];
    const backend = new ClaudeHeadlessBackend(claudeConfig(), undefined, undefined, {
      spawn: (() => fakeProc()) as any,
      toolGateServerFactory: () => {
        const server = createLocalMcpServer();
        const stop = server.stop.bind(server);
        server.stop = async () => { order.push('gate closed'); await stop(); };
        return server;
      },
      terminateProcessTree: async () => { order.push('tree stop'); return { status: 'confirmed-stopped' }; },
    });
    await backend.start({} as NodeJS.ProcessEnv, { pin: 'take' });
    expect(await backend.stop(50)).toEqual({ stopped: true });
    expect(order).toEqual(['gate closed', 'tree stop']);
  });

  it('Claude: reports stop-unconfirmed when the tree stop was not observed, or the launcher had already ended', async () => {
    const unobserved = new ClaudeHeadlessBackend(claudeConfig(), undefined, undefined, {
      spawn: (() => fakeProc()) as any,
      terminateProcessTree: async () => ({ status: 'unknown', detail: 'the process list could not be read' }),
    });
    await unobserved.start({} as NodeJS.ProcessEnv, { pin: 'take' });
    expect(await unobserved.stop(50)).toEqual({ stopped: false, detail: 'the process list could not be read' });

    let proc: any;
    const ended = new ClaudeHeadlessBackend(claudeConfig(), undefined, undefined, {
      spawn: (() => { proc = fakeProc(); return proc; }) as any,
      resolveClaudeLaunch: async () => ({ executable: 'claude-launcher', shell: true }),
      terminateProcessTree: async () => ({ status: 'already-stopped' }),
    });
    await ended.start({} as NodeJS.ProcessEnv, { pin: 'take' });
    proc.exitCode = 0;
    expect(await ended.stop(50)).toEqual({
      stopped: false, detail: 'its launcher had already ended, so the processes it started could not be observed',
    });
  });

  it('Claude: a directly started CLI that had ended before the stop is not confirmed, whichever way the stop finds it', async () => {
    // Still held when the stop starts: the tree stop reports only that the root had ended.
    let proc: any;
    const held = new ClaudeHeadlessBackend(claudeConfig(), undefined, undefined, {
      spawn: (() => { proc = fakeProc(); return proc; }) as any,
      resolveClaudeLaunch: async () => ({ executable: 'claude', shell: false }),
      terminateProcessTree: async () => ({ status: 'already-stopped' }),
    });
    await held.start({} as NodeJS.ProcessEnv, { pin: 'take' });
    proc.exitCode = 0;
    expect(await held.stop(50)).toEqual({ stopped: false, detail: CLAUDE_ENDED });

    // Already let go of: the stop finds no process, and the end it saw says nothing about what that process started.
    let gone: any;
    const released = new ClaudeHeadlessBackend(claudeConfig(), undefined, undefined, {
      spawn: (() => { gone = fakeProc(); return gone; }) as any,
      resolveClaudeLaunch: async () => ({ executable: 'claude', shell: false }),
      terminateProcessTree: async () => { throw new Error('nothing runs, so nothing may be signalled'); },
    });
    await released.start({} as NodeJS.ProcessEnv, { pin: 'take' });
    gone.exitCode = 1;
    gone.emit('exit', 1);
    expect(await until(() => released.pid === undefined, 2_000)).toBe(true);
    expect(await released.stop(50)).toEqual({ stopped: false, detail: CLAUDE_ENDED });
    // A second stop has seen nothing new either.
    expect(await released.stop(50)).toEqual({ stopped: false, detail: CLAUDE_ENDED });
  });

  it('Claude: the end its own observed stop caused is not an end by itself, and a backend that ran nothing is stopped', async () => {
    let proc: any;
    const backend = new ClaudeHeadlessBackend(claudeConfig(), undefined, undefined, {
      spawn: (() => { proc = fakeProc(); return proc; }) as any,
      resolveClaudeLaunch: async () => ({ executable: 'claude', shell: false }),
      terminateProcessTree: async () => { proc.exitCode = 0; proc.emit('exit', 0); return { status: 'confirmed-stopped' }; },
    });
    await backend.start({} as NodeJS.ProcessEnv, { pin: 'take' });
    expect(await backend.stop(50)).toEqual({ stopped: true });
    expect(await until(() => backend.pid === undefined, 2_000)).toBe(true);
    expect(await backend.stop(50)).toEqual({ stopped: true });

    expect(await new ClaudeHeadlessBackend(claudeConfig(), undefined, undefined, {}).stop(50)).toEqual({ stopped: true });

    // A process that never got a number never ran, so its end leaves nothing unseen.
    let unborn: any;
    const neverRan = new ClaudeHeadlessBackend(claudeConfig(), undefined, undefined, {
      spawn: (() => { unborn = fakeProc(); unborn.pid = undefined; return unborn; }) as any,
      resolveClaudeLaunch: async () => ({ executable: 'claude', shell: false }),
    });
    await neverRan.start({} as NodeJS.ProcessEnv, { pin: 'take' });
    unborn.emit('exit', null);
    expect(await until(() => (neverRan as any).proc === undefined, 2_000)).toBe(true);
    expect(await neverRan.stop(50)).toEqual({ stopped: true });
  });

  it('Claude: only signals a process it did not spawn itself, and never calls that stop confirmed', async () => {
    const backend = new ClaudeHeadlessBackend(claudeConfig(), undefined, undefined, { spawn: (() => fakeProc()) as any });
    await backend.start({} as NodeJS.ProcessEnv, { pin: 'take' });
    expect(await backend.stop(50)).toMatchObject({ stopped: false });
  });

  it('Codex: does not count a stop sent by process number, or one not observed, as confirmed', async () => {
    const byNumber = new CodexBackend(codexConfig(), undefined, {
      launchProgram: fixedCodexProgram('codex'), access: () => ({ trusted: true, restricted: false, readRoots: [process.cwd()], writeRoots: [] }),
      killProcessTree: async () => undefined,
    });
    (byNumber as any).proc = fakeProc();
    expect(await byNumber.stop()).toMatchObject({ stopped: false });

    const unobserved = new CodexBackend(codexConfig(), undefined, {
      launchProgram: fixedCodexProgram('codex'), access: () => ({ trusted: true, restricted: false, readRoots: [process.cwd()], writeRoots: [] }),
      terminateProcessTree: async () => ({ status: 'unknown', detail: 'process 99 was still running' }),
    });
    (unobserved as any).proc = fakeProc();
    expect(await unobserved.stop()).toEqual({ stopped: false, detail: 'process 99 was still running' });
  });

  it('Codex: App Server that had ended before the stop is not confirmed, whichever way the stop finds it', async () => {
    const access = () => ({ trusted: true, restricted: false, readRoots: [process.cwd()], writeRoots: [] });
    // Still held when the stop starts: the tree stop reports only that the root had ended.
    const held = new CodexBackend(codexConfig(), undefined, {
      launchProgram: fixedCodexProgram('codex'), access, terminateProcessTree: async () => ({ status: 'already-stopped' }),
    });
    (held as any).proc = fakeProc();
    expect(await held.stop()).toEqual({ stopped: false, detail: CODEX_ENDED });

    // Ended by itself and let go of: the stop finds no process.
    const proc = fakeProc();
    const released = new CodexBackend(codexConfig(), undefined, {
      launchProgram: fixedCodexProgram('codex'), access, spawn: (() => proc) as any,
      terminateProcessTree: async () => { throw new Error('nothing runs, so nothing may be signalled'); },
    });
    (released as any).spawnAppServer();
    (released as any).started = true;
    proc.exitCode = 1;
    proc.emit('exit', 1);
    expect(released.pid).toBeUndefined();
    expect(await released.stop()).toEqual({ stopped: false, detail: CODEX_ENDED });
    expect(await released.stop()).toEqual({ stopped: false, detail: CODEX_ENDED });
  });

  it('Codex: a replaced App Server whose tree was not seen to stop keeps the next stop unconfirmed', async () => {
    const outcomes: ProcessTerminationOutcome[] = [
      { status: 'unknown', detail: 'process 41 was still running' },
      { status: 'confirmed-stopped' },
    ];
    const backend = new CodexBackend(codexConfig(), undefined, {
      launchProgram: fixedCodexProgram('codex'), access: () => ({ trusted: true, restricted: false, readRoots: [process.cwd()], writeRoots: [] }),
      spawn: (() => fakeProc()) as any,
      terminateProcessTree: async () => outcomes.shift()!,
    });
    // The two steps of an App Server restart: the old process is stopped, and a new one is started in its place.
    (backend as any).spawnAppServer();
    await (backend as any).killRunningProcess();
    (backend as any).spawnAppServer();
    (backend as any).started = true;

    expect(await backend.stop()).toEqual({ stopped: false, detail: 'process 41 was still running' });
    expect(outcomes).toEqual([]);
  });

  it('Codex: a confirmed stop is stopped, also when asked again, and a backend that ran nothing is stopped', async () => {
    const access = () => ({ trusted: true, restricted: false, readRoots: [process.cwd()], writeRoots: [] });
    const proc = fakeProc();
    const backend = new CodexBackend(codexConfig(), undefined, {
      launchProgram: fixedCodexProgram('codex'), access, spawn: (() => proc) as any,
      terminateProcessTree: async () => { proc.exitCode = 0; proc.emit('exit', 0); return { status: 'confirmed-stopped' }; },
    });
    (backend as any).spawnAppServer();
    (backend as any).started = true;
    expect(await backend.stop()).toEqual({ stopped: true });
    expect(await backend.stop()).toEqual({ stopped: true });

    expect(await new CodexBackend(codexConfig(), undefined, { launchProgram: fixedCodexProgram('codex'), access }).stop()).toEqual({ stopped: true });

    // A process that never got a number never ran, so its end leaves nothing unseen.
    const unborn = fakeProc();
    unborn.pid = undefined;
    const neverRan = new CodexBackend(codexConfig(), undefined, { launchProgram: fixedCodexProgram('codex'), access, spawn: (() => unborn) as any });
    (neverRan as any).spawnAppServer();
    unborn.emit('exit', null);
    expect(await neverRan.stop()).toEqual({ stopped: true });
  });

  it('OpenAI-compatible: confirms its stop only when every background command it leaves was seen to stop', async () => {
    const backend = new OpenAICompatBackend(claudeConfig());
    (backend as any).tools.disposeBackground = async () => ({
      unconfirmed: [{ id: 'bg-1', command: 'npm run watch', detail: 'process 77 was still running' }],
    });
    expect(await backend.stop()).toEqual({
      stopped: false, detail: '1 background command(s) could not be confirmed stopped: process 77 was still running',
    });

    const clean = new OpenAICompatBackend(claudeConfig());
    expect(await clean.stop()).toEqual({ stopped: true });
  });
});
