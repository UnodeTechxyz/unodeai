import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeHeadlessBackend } from '../../backend/ClaudeHeadlessBackend';
import { createLocalMcpServer, type LocalJsonEndpoint, type LocalMcpServer } from '../../mcp/LocalMcpServer';
import type { AgentConfig } from '../../types';
import type { GateProbeSpawn } from '../cliGateProbeRun';
import {
  CLAUDE_GATE_PROBE_ARGS,
  claudeProbeEnv,
  claudeToolGateHook,
  claudeToolGateWrapperSource,
  runClaudeGateProbe,
} from '../claudeGateProbe';

// The design these tests realise: CP1, the Claude CLI compatibility check after the user's OK. `--version` must
// parse; then the production argument shape in `-p` stream-json mode with no message, a settings file holding the
// production PreToolUse gate and a SessionStart hook that reports to a loopback endpoint with a one-time token. Pass:
// the callback arrives within 20 s; then the tree is stopped while it runs. The environment is the agent environment
// without CLAUDE*, ANTHROPIC_* and MCP_CONNECTION_NONBLOCKING.

import { removeTestFolder } from './support/removeTestFolder';

const FAKE = path.join(__dirname, 'fixtures', 'fakeClaudeCli.cjs');
const GATE_SCRIPT = path.resolve(__dirname, '..', '..', 'claudeToolGate.cjs');
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
  const dir = mkdtempSync(path.join(tmpdir(), 'unode-claude-probe-'));
  const logFile = path.join(dir, 'log.jsonl');
  const controlFile = path.join(dir, 'control.json');
  writeFileSync(controlFile, JSON.stringify({ log: logFile, ...control }));
  const spawns: Array<{ command: string; args: string[]; options: any }> = [];
  const procs: ChildProcess[] = [];
  temps.push({ folder: dir, pids: () => procs.map((proc) => proc.pid) });
  const spawn: GateProbeSpawn = (command, args, options) => {
    spawns.push({ command, args: [...args], options });
    const proc = nodeSpawn(process.execPath, [FAKE, controlFile, ...args], { ...options, shell: false });
    procs.push(proc);
    return proc;
  };
  const events = (): any[] => (existsSync(logFile)
    ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []);
  const cleanup = () => {
    for (const proc of procs) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  };
  return { dir, spawn, spawns, events, cleanup, probeCwd: path.join(dir, 'probe-cwd') };
}

const agentEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  KEEP_ME: '1',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
  claude_config_dir: 'x',
  ANTHROPIC_API_KEY: 'sk-ant',
  anthropic_base_url: 'https://example.invalid',
  MCP_CONNECTION_NONBLOCKING: 'true',
});

describe('Claude CP1', () => {
  it('passes when the SessionStart hook of its settings reaches UnodeAi, then stops the tree while it runs', async () => {
    const h = harness();
    const spawned: Array<[number, string]> = [];
    // The real loopback server, with every answer of its endpoint recorded.
    const answers: Array<{ body: Record<string, unknown>; answer: Record<string, unknown> }> = [];
    const createServer = (): LocalMcpServer => {
      const server = createLocalMcpServer();
      const add = server.addJsonEndpoint.bind(server);
      server.addJsonEndpoint = (endpoint: LocalJsonEndpoint) => add({
        ...endpoint,
        handler: async (body) => {
          const answer = await endpoint.handler(body);
          answers.push({ body, answer });
          return answer;
        },
      });
      return server;
    };
    try {
      const result = await runClaudeGateProbe(
        { launch: { executable: 'C:\\claude\\claude.exe', shell: false }, probeCwd: h.probeCwd, workspaceRoots: [], agentEnv: agentEnv() },
        { spawn: h.spawn, toolGateScriptPath: GATE_SCRIPT, createServer, onSpawned: (pid, step) => spawned.push([pid, step]) },
      );
      expect(result).toMatchObject({ result: 'pass', version: '2.1.304', versionOutput: '2.1.304 (Claude Code)' });
      expect(spawned.map(([, step]) => step)).toEqual(['version', 'session']);
      const session = h.spawns[1];
      expect(session.args.slice(0, CLAUDE_GATE_PROBE_ARGS.length)).toEqual([...CLAUDE_GATE_PROBE_ARGS]);
      expect(session.args.slice(CLAUDE_GATE_PROBE_ARGS.length - session.args.length)).toEqual(['--settings', expect.stringMatching(/^\.unode\/claude-probe\/[0-9a-f]{32}\/claude-gate-probe\.json$/)]);
      // The settings held the production PreToolUse gate and the SessionStart hook, through one private wrapper.
      const settings = h.events().find((event) => event.event === 'settings').settings;
      const command: string = settings.hooks.SessionStart[0].hooks[0].command;
      expect(command).toMatch(/^".+"$/);
      const wrapper = command.slice(1, -1);
      expect(settings.hooks.PreToolUse).toEqual([claudeToolGateHook(wrapper)]);
      expect(settings.hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command: `"${wrapper}"`, timeout: 10 }] }]);
      // The hook's process reached the endpoint through the shipped gate script, and the endpoint denies every tool.
      // The check passes on that arrival and stops the tree at once, so whether the hook process itself still exits
      // and prints the decision first is a race (it does on Windows, not always on Linux); when it does, it is a deny.
      expect(answers).toEqual([{
        body: expect.objectContaining({ hook_event_name: 'SessionStart', session_id: 'fake' }),
        answer: { allow: false, reason: expect.stringContaining('no tool runs during the check') },
      }]);
      const hook = h.events().find((event) => event.event === 'hook-exit');
      if (hook) expect(hook).toMatchObject({ code: 0, out: expect.stringContaining('"permissionDecision":"deny"') });
      for (const start of h.events().filter((event) => event.event === 'start')) {
        // Native on both sides: the child reports its folder with 8.3 short names expanded, and plain realpathSync keeps them.
        expect(realpathSync.native(start.cwd)).toBe(realpathSync.native(h.probeCwd));
        expect(start.env.KEEP_ME).toBe('1');
        expect(Object.keys(start.env).filter((key) => /^(claude|anthropic_)/i.test(key) || key.toUpperCase() === 'MCP_CONNECTION_NONBLOCKING')).toEqual([]);
      }
      // Stopped while it ran, before its input ended; and the check's files are gone with its endpoint.
      expect(alive(spawned[1][0])).toBe(false);
      expect(h.events().some((event) => event.event === 'stdin-end')).toBe(false);
      expect(existsSync(path.join(h.probeCwd, '.unode'))).toBe(false);
    } finally {
      h.cleanup();
    }
  }, 60_000);

  it('fails when the program ignores the settings, and stops it', async () => {
    const h = harness({ ignoreHooks: true });
    const spawned: number[] = [];
    try {
      const result = await runClaudeGateProbe(
        { launch: { executable: 'C:\\claude\\claude.exe', shell: false }, probeCwd: h.probeCwd, workspaceRoots: [], agentEnv: agentEnv() },
        { spawn: h.spawn, toolGateScriptPath: GATE_SCRIPT, timeoutMs: 4_000, onSpawned: (pid) => spawned.push(pid) },
      );
      expect(result).toMatchObject({ result: 'fail', detail: expect.stringMatching(/SessionStart hook did not reach UnodeAi within 4 seconds/) });
      expect(alive(spawned[1])).toBe(false);
    } finally {
      h.cleanup();
    }
  }, 60_000);

  it('starts nothing more when --version does not print a Claude CLI version', async () => {
    const h = harness({ version: 'something else' });
    try {
      const result = await runClaudeGateProbe(
        { launch: { executable: 'C:\\claude\\claude.exe', shell: false }, probeCwd: h.probeCwd, workspaceRoots: [], agentEnv: agentEnv() },
        { spawn: h.spawn, toolGateScriptPath: GATE_SCRIPT },
      );
      expect(result).toMatchObject({ result: 'fail', detail: expect.stringMatching(/did not print a Claude CLI version/) });
      expect(h.spawns.map((call) => call.args[0])).toEqual(['--version']);
    } finally {
      h.cleanup();
    }
  }, 60_000);

  it('reports an unconfirmed stop when Claude ended by itself before the hook arrived', async () => {
    const h = harness({ ignoreHooks: true, exitAt: 200 });
    try {
      const result = await runClaudeGateProbe(
        { launch: { executable: 'C:\\claude\\claude.exe', shell: false }, probeCwd: h.probeCwd, workspaceRoots: [], agentEnv: agentEnv() },
        { spawn: h.spawn, toolGateScriptPath: GATE_SCRIPT },
      );
      expect(result).toMatchObject({ result: 'stop-unconfirmed', detail: expect.stringMatching(/exited with code 0 before its SessionStart hook reached UnodeAi/) });
    } finally {
      h.cleanup();
    }
  }, 60_000);

  it('starts npm\'s launcher through cmd.exe as one quoted token, and nothing in a workspace', async () => {
    const h = harness();
    try {
      const result = await runClaudeGateProbe(
        { launch: { executable: 'C:\\Users\\Ada Lovelace\\npm\\claude.cmd', shell: true }, probeCwd: h.probeCwd, workspaceRoots: [], agentEnv: agentEnv() },
        { spawn: h.spawn, toolGateScriptPath: GATE_SCRIPT },
      );
      expect(result.result).toBe('pass');
      for (const call of h.spawns) {
        expect(call.command).toBe('"C:\\Users\\Ada Lovelace\\npm\\claude.cmd"');
        expect(call.options.shell).toBe(true);
      }
      const workspace = path.join(h.dir, 'workspace');
      mkdirSync(workspace);
      const before = h.spawns.length;
      const refused = await runClaudeGateProbe(
        { launch: { executable: 'C:\\claude\\claude.exe', shell: false }, probeCwd: path.join(workspace, 'probe'), workspaceRoots: [workspace], agentEnv: agentEnv() },
        { spawn: h.spawn, toolGateScriptPath: GATE_SCRIPT },
      );
      expect(refused).toMatchObject({ result: 'fail', detail: expect.stringMatching(/inside a workspace folder/) });
      expect(h.spawns.length).toBe(before);
    } finally {
      h.cleanup();
    }
  }, 60_000);

  it('strips Claude\'s own, Anthropic\'s and MCP_CONNECTION_NONBLOCKING in any case, and keeps the rest', () => {
    expect(claudeProbeEnv({ CLAUDECODE: '1', Claude_Config_Dir: 'x', ANTHROPIC_API_KEY: 'k', anthropic_auth_token: 't', mcp_connection_nonblocking: '1', PATH: 'p', ANTHROPICX: 'kept' }))
      .toEqual({ PATH: 'p', ANTHROPICX: 'kept' });
  });
});

describe('the check\'s PreToolUse gate is the one a Claude agent starts with', () => {
  it('writes the same hook entry and the same wrapper as ClaudeHeadlessBackend', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'unode-claude-parity-'));
    temps.push({ folder: dir, pids: () => [] });
    const endpoints: LocalJsonEndpoint[] = [];
    const server: LocalMcpServer = {
      port: 48123, token: 'test-token',
      addLocalTool: () => undefined, addJsonEndpoint: (endpoint) => { endpoints.push(endpoint); },
      observeToolOutcomes: () => undefined, start: async () => undefined, stop: async () => undefined,
    };
    const spawn = () => {
      const proc = new EventEmitter() as any;
      proc.pid = 1234;
      proc.exitCode = null;
      proc.stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
      proc.stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
      proc.stdin = { write: () => true, end: () => undefined };
      proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); return true; };
      setTimeout(() => proc.emit('spawn'), 0);
      return proc;
    };
    const config: AgentConfig = {
      id: 'claude-1', name: 'Claude Dev', role: 'developer', skill: '',
      provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' }, model: 'claude-sonnet-4-5',
      systemPrompt: 'x', autoApprove: true, allowedTools: ['read', 'write', 'execute'], backend: 'claude', workingDirectory: dir,
    };
    const backend = new ClaudeHeadlessBackend(config, undefined, undefined, { spawn: spawn as any, toolGateServerFactory: () => server, toolGateScriptPath: GATE_SCRIPT });
    try {
      await backend.start({} as NodeJS.ProcessEnv, { pin: 'take' });
      const launch = path.join(dir, '.unode', 'claude');
      const [id] = readdirSync(launch);
      const settings = JSON.parse(readFileSync(path.join(launch, id, 'claude-tool-gate.json'), 'utf8'));
      const wrapperFile = path.join(launch, id, `claude-tool-gate.${process.platform === 'win32' ? 'cmd' : 'sh'}`);
      expect(settings.hooks.PreToolUse).toEqual([claudeToolGateHook(wrapperFile)]);
      expect(readFileSync(wrapperFile, 'utf8')).toBe(claudeToolGateWrapperSource(process.execPath, GATE_SCRIPT, 'http://127.0.0.1:48123/gate', 'test-token', process.platform));
    } finally {
      await backend.stop(50);
    }
  }, 30_000);
});
