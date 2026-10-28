import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCodexAppServerArgs, codexProjectTrustOverride } from '../../backend/CodexSpawnArgs';
import { terminateChildProcessTree } from '../../backend/processTree';
import type { GateProbeSpawn } from '../cliGateProbeRun';
import {
  CODEX_GATE_PROBE_METHODS,
  GATE_PROBE_LIMITS,
  managedCodexProbeEnv,
  runExternalCodexGateProbe,
  runManagedCodexGateProbe,
} from '../codexGateProbe';
import type { WorkFolder } from '../managedCli/contracts';
import { removeTestFolder } from './support/removeTestFolder';

// The design these tests realise: the gate-compatibility probe of an External Codex program after the user's OK, and
// the post-click probe of a managed version. It sends initialize, initialized and config/read only, requires every
// production assertion, runs in UnodeAi's own folder, and stops the App Server's tree while the root still runs,
// without ending its input first (App Server exits when its input ends, which would leave its tree unobserved).
// 20 s and 64 KiB for the whole check. Managed: the environment is exactly the allowlist, with an empty owned
// CODEX_HOME. External: the user's CODEX_HOME, and the untrusted project override for the check's folder.

const FAKE = path.join(__dirname, 'fixtures', 'fakeCodexCli.cjs');
// Each folder with the processes that worked in it. A folder Windows still holds after the retries fails the test only
// when one of them still runs (see removeTestFolder).
const temps: Array<{ folder: string; pids: () => Array<number | undefined> }> = [];
afterEach(() => {
  for (const { folder, pids } of temps.splice(0)) removeTestFolder(folder, pids());
}, 30_000);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function harness(control: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'unode-codex-probe-'));
  const logFile = path.join(dir, 'log.jsonl');
  const controlFile = path.join(dir, 'control.json');
  writeFileSync(controlFile, JSON.stringify({ log: logFile, ...control }));
  const spawns: Array<{ command: string; args: string[]; options: any }> = [];
  const procs: ChildProcess[] = [];
  temps.push({ folder: dir, pids: () => [...procs.map((proc) => proc.pid), ...events().map((event) => event.pid)] });
  /** The spawn spy: every start of "the program" is recorded, and a Node process runs the fake in its place. */
  const spawn: GateProbeSpawn = (command, args, options) => {
    spawns.push({ command, args: [...args], options });
    const proc = nodeSpawn(process.execPath, [FAKE, controlFile, ...args], options);
    procs.push(proc);
    return proc;
  };
  const events = (): any[] => (existsSync(logFile)
    ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []);
  const received = () => events().filter((event) => event.event === 'received').map((event) => event.message);
  const starts = () => events().filter((event) => event.event === 'start');
  const workFolder = (): WorkFolder => {
    const root = path.join(dir, 'work', 'a'.repeat(32), 'b'.repeat(32));
    for (const name of ['cwd', 'tmp', 'home']) mkdirSync(path.join(root, name), { recursive: true });
    return { storeId: 'a'.repeat(32), token: 'b'.repeat(32), root, cwd: path.join(root, 'cwd'), tmp: path.join(root, 'tmp'), home: path.join(root, 'home') };
  };
  const cleanup = () => {
    for (const proc of procs) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    for (const event of events()) if (event.event === 'child' && alive(event.pid)) process.kill(event.pid, 'SIGKILL');
  };
  return { dir, spawn, spawns, events, received, starts, workFolder, cleanup, controlFile };
}

/** The host environment, with everything the managed check must leave out. */
function hostEnv(dir: string): NodeJS.ProcessEnv {
  return {
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    windir: process.env.windir ?? process.env.WINDIR ?? 'C:\\Windows',
    ComSpec: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    USERPROFILE: process.env.USERPROFILE ?? '/home/unode',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\unode',
    APPDATA: process.env.APPDATA ?? '/home/unode/.config',
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? '/home/unode/.local',
    PATH: process.env.PATH,
    NODE_OPTIONS: '--no-warnings',
    HTTPS_PROXY: 'http://proxy.invalid:8080',
    http_proxy: 'http://proxy.invalid:8080',
    npm_config_prefix: '/npm',
    OPENAI_API_KEY: 'sk-test',
    CODEX_API_KEY: 'codex-test',
    CODEX_MANAGED_BY_NPM: '1',
    ELECTRON_RUN_AS_NODE: '1',
    CODEX_HOME: path.join(dir, 'users-own-codex-home'),
  };
}

function ownKeys(env: Record<string, string>): string[] {
  // Windows keeps per-drive folders as hidden `=C:` entries; they are not variables anyone set.
  return Object.keys(env).filter((key) => !key.startsWith('=')).sort();
}

const VERSION = 'codex-cli 0.163.0';

/** libuv's required Windows variables (src/win/process.c) that the allowlist does not already carry. */
const LIBUV_WINDOWS_ADDED = ['LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME'];

describe('the managed post-click Codex check', () => {
  it('sends exactly initialize, initialized and config/read, in the check\'s folders, with only the allowlisted environment', async () => {
    const h = harness();
    const work = h.workFolder();
    const env = hostEnv(h.dir);
    const spawned: Array<[number, string]> = [];
    try {
      const result = await runManagedCodexGateProbe(
        { executable: 'C:\\store\\versions\\k\\bin\\codex.exe', workFolder: work, expectedVersionOutput: VERSION, hostEnv: env },
        { spawn: h.spawn, onSpawned: (pid, step) => spawned.push([pid, step]) },
      );
      expect(result).toMatchObject({ result: 'pass', versionOutput: VERSION });
      expect(h.received().filter((message) => message.method !== undefined).map((message) => message.method)).toEqual([...CODEX_GATE_PROBE_METHODS]);
      expect(h.received().find((message) => message.method === 'config/read')?.params).toEqual({ cwd: work.cwd, includeLayers: true });
      expect(h.spawns.map((call) => call.args[0])).toEqual(['--version', 'app-server']);
      expect(spawned.map(([, step]) => step)).toEqual(['version', 'app-server']);
      // The untrusted project override names the check's own folder.
      const appServer = h.spawns[1];
      expect(appServer.args).toEqual(buildCodexAppServerArgs({ projectRoot: work.cwd, mode: 'user-only' }, 'ask-for-approval'));
      expect(appServer.args).toContain(codexProjectTrustOverride([work.cwd], 'untrusted'));
      const expected = managedCodexProbeEnv(env, work);
      expect(Object.keys(expected).sort()).toEqual(['APPDATA', 'CODEX_HOME', 'ComSpec', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR'].sort());
      // What UnodeAi passes is exactly the allowlist, for both starts.
      for (const call of h.spawns) expect(call.options.env).toEqual(expected);
      for (const start of h.starts()) {
        // On Windows, Node (libuv) adds the variables it requires from the extension host's own environment when
        // the given environment lacks them: these four, and nothing else. Elsewhere the child gets exactly the list.
        const added = process.platform === 'win32' ? LIBUV_WINDOWS_ADDED.filter((name) => process.env[name] !== undefined) : [];
        expect(ownKeys(start.env)).toEqual([...Object.keys(expected), ...added].sort());
        for (const name of added) expect(start.env[name]).toBe(process.env[name]);
        for (const [key, value] of Object.entries(expected)) expect(start.env[key]).toBe(value);
        expect(start.env.CODEX_HOME).toBe(work.home);
        expect(start.env.PATH).toBe(`${env.SystemRoot}\\System32;${env.SystemRoot}`);
        expect(start.env.TEMP).toBe(work.tmp);
        expect(realpathSync.native(start.cwd)).toBe(realpathSync.native(work.cwd));
      }
      // The tree was stopped: the App Server is gone.
      expect(alive(spawned[1][0])).toBe(false);
    } finally {
      h.cleanup();
    }
  }, 60_000);

  it('runs nothing else when --version is not the policy\'s exact text, and nothing at all when its home is not empty', async () => {
    const h = harness({ versionOutput: 'codex-cli 0.163.1' });
    const work = h.workFolder();
    try {
      const wrong = await runManagedCodexGateProbe({ executable: 'C:\\k\\codex.exe', workFolder: work, expectedVersionOutput: VERSION, hostEnv: hostEnv(h.dir) }, { spawn: h.spawn });
      expect(wrong).toMatchObject({ result: 'fail', versionOutput: 'codex-cli 0.163.1' });
      expect(h.spawns.map((call) => call.args[0])).toEqual(['--version']);

      writeFileSync(path.join(work.home, 'config.toml'), 'model = "x"\n');
      const before = h.spawns.length;
      const used = await runManagedCodexGateProbe({ executable: 'C:\\k\\codex.exe', workFolder: work, expectedVersionOutput: VERSION, hostEnv: hostEnv(h.dir) }, { spawn: h.spawn });
      expect(used).toMatchObject({ result: 'fail', detail: expect.stringMatching(/own Codex home is not empty/) });
      expect(h.spawns.length).toBe(before);
    } finally {
      h.cleanup();
    }
  }, 60_000);

  it('never sends login status, and refuses without SystemRoot before anything starts', async () => {
    const h = harness();
    const work = h.workFolder();
    try {
      const { SystemRoot: _dropped, ...noRoot } = hostEnv(h.dir);
      const result = await runManagedCodexGateProbe({ executable: 'C:\\k\\codex.exe', workFolder: work, expectedVersionOutput: VERSION, hostEnv: noRoot }, { spawn: h.spawn });
      expect(result).toMatchObject({ result: 'fail', detail: expect.stringMatching(/SystemRoot/) });
      expect(h.spawns).toEqual([]);
      const passed = await runManagedCodexGateProbe({ executable: 'C:\\k\\codex.exe', workFolder: work, expectedVersionOutput: VERSION, hostEnv: hostEnv(h.dir) }, { spawn: h.spawn });
      expect(passed.result).toBe('pass');
      expect(h.spawns.some((call) => call.args.includes('login'))).toBe(false);
    } finally {
      h.cleanup();
    }
  }, 60_000);
});

describe('the External Codex check', () => {
  it('runs the existing preflight, then the handshake, with the user\'s CODEX_HOME and the final environment filter', async () => {
    const h = harness();
    const probeCwd = path.join(h.dir, 'probe-cwd');
    const userHome = path.join(h.dir, 'users-own-codex-home');
    const agentEnv = {
      ...hostEnv(h.dir), CODEX_HOME: userHome, KEEP_ME: '1',
      CODEX_MANAGED_BY_NPM: '1', codex_managed_by_bun: '1', Codex_Managed_By_Brew: '1', OpenAI_Api_Key: 'k',
    };
    try {
      const result = await runExternalCodexGateProbe({ executable: FAKE, probeCwd, workspaceRoots: [path.join(h.dir, 'workspace')], agentEnv }, { spawn: h.spawn });
      expect(result).toMatchObject({ result: 'pass', version: '0.163.0', versionOutput: VERSION });
      expect(h.spawns.map((call) => call.args.slice(0, 2))).toEqual([['--version'], ['login', 'status'], ['app-server', '--stdio']]);
      expect(h.received().filter((message) => message.method !== undefined).map((message) => message.method)).toEqual([...CODEX_GATE_PROBE_METHODS]);
      // The neutral folder is resolved with realpathSync.native (8.3 short names expanded), so the expectation is too.
      const physicalCwd = realpathSync.native(probeCwd);
      expect(h.spawns[2].args).toEqual(buildCodexAppServerArgs({ projectRoot: physicalCwd, mode: 'user-only' }, 'ask-for-approval'));
      expect(h.spawns[2].args).toContain(codexProjectTrustOverride([physicalCwd], 'untrusted'));
      for (const start of h.starts()) {
        expect(start.env.CODEX_HOME).toBe(userHome);
        expect(start.env.KEEP_ME).toBe('1');
        expect(Object.keys(start.env).filter((key) => /^codex_managed_by_/i.test(key) || /^(openai|codex)_api_key$/i.test(key))).toEqual([]);
        expect(realpathSync.native(start.cwd)).toBe(physicalCwd);
      }
    } finally {
      h.cleanup();
    }
  }, 60_000);

  it('stops at the preflight: a version below the floor or a logged-out program never reaches the App Server', async () => {
    const old = harness({ versionOutput: 'codex-cli 0.154.0' });
    const loggedOut = harness({ loginOutput: 'Not logged in', loginExit: 1 });
    try {
      for (const h of [old, loggedOut]) {
        const result = await runExternalCodexGateProbe({ executable: FAKE, probeCwd: path.join(h.dir, 'probe-cwd'), workspaceRoots: [], agentEnv: hostEnv(h.dir) }, { spawn: h.spawn });
        expect(result.result).toBe('fail');
        expect(h.spawns.some((call) => call.args[0] === 'app-server')).toBe(false);
      }
      expect(old.spawns.map((call) => call.args[0])).toEqual(['--version']);
      expect(loggedOut.spawns.map((call) => call.args[0])).toEqual(['--version', 'login']);
    } finally {
      old.cleanup();
      loggedOut.cleanup();
    }
  }, 60_000);

  it('starts nothing in a folder inside a workspace', async () => {
    const h = harness();
    const workspace = path.join(h.dir, 'workspace');
    mkdirSync(workspace);
    const result = await runExternalCodexGateProbe({ executable: FAKE, probeCwd: path.join(workspace, 'probe'), workspaceRoots: [workspace], agentEnv: hostEnv(h.dir) }, { spawn: h.spawn });
    expect(result).toMatchObject({ result: 'fail', detail: expect.stringMatching(/inside a workspace folder/) });
    expect(h.spawns).toEqual([]);
  });
});

describe('what the App Server must report (both checks)', () => {
  const managed = (h: ReturnType<typeof harness>, deps: Record<string, unknown> = {}) => runManagedCodexGateProbe(
    { executable: 'C:\\k\\codex.exe', workFolder: h.workFolder(), expectedVersionOutput: VERSION, hostEnv: hostEnv(h.dir) },
    { spawn: h.spawn, ...deps },
  );

  it.each([
    ['analytics', { analytics: { enabled: true } }, /analytics remained enabled/],
    ['the approval policy', { approval_policy: 'never' }, /approval policy did not win/],
    ['the sandbox', { sandbox_mode: 'danger-full-access' }, /sandbox profile did not win/],
  ])('fails when %s is not the host-owned value', async (_name, config, message) => {
    const h = harness({ appServer: { config } });
    try {
      expect(await managed(h)).toMatchObject({ result: 'fail', detail: expect.stringMatching(message) });
    } finally {
      h.cleanup();
    }
  }, 60_000);

  it('fails when the project layer is not disabled, and when config/read answers an error', async () => {
    const layer = harness({ appServer: { layers: [{ name: { type: 'project', dotCodexFolder: 'x' }, config: {} }] } });
    const error = harness({ appServer: { configError: 'unknown method' } });
    try {
      expect(await managed(layer)).toMatchObject({ result: 'fail', detail: expect.stringMatching(/did not disable the project configuration layer/) });
      expect(await managed(error)).toMatchObject({ result: 'fail', detail: 'unknown method' });
    } finally {
      layer.cleanup();
      error.cleanup();
    }
  }, 60_000);

  it('declines a request of the server as an agent start does, and still passes', async () => {
    const h = harness({ appServer: { serverRequest: true } });
    try {
      expect((await managed(h)).result).toBe('pass');
      expect(h.received().find((message) => message.id === 'server-1')).toMatchObject({ error: { code: -32601 } });
    } finally {
      h.cleanup();
    }
  }, 60_000);
});

describe('the stop and the bounds', () => {
  it('stops the tree while the root runs, before its input ends; a root that exits when its input ends still gives a confirmed stop', async () => {
    const h = harness({ appServer: { exitOnStdinEnd: true, spawnChild: true } });
    const seen: Array<{ running: boolean; inputEnded: boolean }> = [];
    try {
      const result = await runManagedCodexGateProbe(
        { executable: 'C:\\k\\codex.exe', workFolder: h.workFolder(), expectedVersionOutput: VERSION, hostEnv: hostEnv(h.dir) },
        {
          spawn: h.spawn,
          terminateTree: (proc) => {
            seen.push({ running: proc.exitCode === null && proc.signalCode === null, inputEnded: proc.stdin?.writableEnded === true });
            return terminateChildProcessTree(proc);
          },
        },
      );
      expect(seen).toEqual([{ running: true, inputEnded: false }]);
      expect(result.result).toBe('pass');
      // The App Server never saw its input end: it was stopped first.
      expect(h.events().some((event) => event.event === 'stdin-end')).toBe(false);
      // What it started went with it.
      const child = h.events().find((event) => event.event === 'child');
      expect(child).toBeDefined();
      expect(alive(child.pid)).toBe(false);
    } finally {
      h.cleanup();
    }
  }, 60_000);

  it('reports a stop as unconfirmed when the App Server ended before it, since what it started was not observed', async () => {
    // The fake ends by itself on config/read, before answering it.
    const h = harness({ appServer: { exitOnConfigRead: true } });
    try {
      const result = await runManagedCodexGateProbe(
        { executable: 'C:\\k\\codex.exe', workFolder: h.workFolder(), expectedVersionOutput: VERSION, hostEnv: hostEnv(h.dir) },
        { spawn: h.spawn },
      );
      expect(result).toMatchObject({ result: 'stop-unconfirmed', detail: expect.stringMatching(/could not confirm that the check's process stopped \(the program had already ended before the stop/) });
      expect(result).toMatchObject({ detail: expect.stringMatching(/exited with code 0 before the check finished/) });
    } finally {
      h.cleanup();
    }
  }, 60_000);

  it('stops the tree on the timeout', async () => {
    const h = harness({ appServer: { hang: true } });
    const spawned: number[] = [];
    try {
      const result = await runManagedCodexGateProbe(
        { executable: 'C:\\k\\codex.exe', workFolder: h.workFolder(), expectedVersionOutput: VERSION, hostEnv: hostEnv(h.dir) },
        { spawn: h.spawn, timeoutMs: 3_000, onSpawned: (pid) => spawned.push(pid) },
      );
      expect(result).toMatchObject({ result: 'fail', detail: 'the check did not finish within 3 seconds' });
      expect(alive(spawned[1])).toBe(false);
      // It was asked to initialize and nothing more.
      expect(h.received().map((message) => message.method)).toEqual(['initialize']);
    } finally {
      h.cleanup();
    }
  }, 60_000);

  it('stops the tree when the program prints more than 64 KiB', async () => {
    const h = harness({ appServer: { flood: 70 * 1024 } });
    const spawned: number[] = [];
    try {
      const result = await runManagedCodexGateProbe(
        { executable: 'C:\\k\\codex.exe', workFolder: h.workFolder(), expectedVersionOutput: VERSION, hostEnv: hostEnv(h.dir) },
        { spawn: h.spawn, onSpawned: (pid) => spawned.push(pid) },
      );
      expect(result).toMatchObject({ result: 'fail', detail: 'the program printed more than 64 KiB' });
      expect(alive(spawned[1])).toBe(false);
    } finally {
      h.cleanup();
    }
  }, 60_000);

  it('bounds every check at 20 seconds and 64 KiB', () => {
    expect(GATE_PROBE_LIMITS).toEqual({ timeoutMs: 20_000, outputBytes: 64 * 1024 });
  });
});
